import {
  ReadListItemResponse,
  ReadListItemCreateInput,
  ReadListItemUpdateInput
} from '../../types/readlist.types';
import {
  ReadListItemNotFoundError,
  ReadListItemAlreadyExistsError,
  ReadListItemValidationError,
  ReadListNotFoundError,
  ReadListResourceNotFoundError,
  ReadListPermissionError
} from '../../errors/readlist.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { CACHE_PREFIX, CACHE_KEYS } from '../../constants/cache.constants';
import {
  readListItemCreateSchema,
  readListItemUpdateSchema,
  readListItemQuerySchema
} from '../../schemas/readlist.schema';
import { readListItemRepository, readListRepository, educationalResourceRepository } from '../../repositories';
import { BaseService } from '../../core/crudBase.service';
import { cacheService } from '../../core/cache.service';
import { transactionService } from '../../core/transaction.service';
import { CACHE_TTL } from '../../constants/cache.constants';
import { xpService } from '../xp/xp.service';

// Type pour les paramètres de requête
type ReadListItemQueryParams = {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  readListId?: number;
  isRead?: boolean;
};

export class ReadListItemService extends BaseService<
  ReadListItemResponse,
  ReadListItemCreateInput,
  ReadListItemUpdateInput,
  ReadListItemQueryParams
> {
  protected repository = readListItemRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.READLIST_ITEM;
  protected validationSchemas = {
    create: readListItemCreateSchema,
    update: readListItemUpdateSchema,
    query: readListItemQuerySchema
  };
  protected errorClasses = {
    notFound: ReadListItemNotFoundError,
    alreadyExists: ReadListItemAlreadyExistsError,
    validation: ReadListItemValidationError
  };

  /**
   * Vérifie si un item avec la ressource donnée existe déjà dans cette read list
   * @param data Données de l'item
   * @returns true si l'item existe déjà, false sinon
   */
  protected async checkExists(data: ReadListItemCreateInput): Promise<boolean> {
    if (!data.readListId) {
      throw new ReadListItemValidationError('readListId is required');
    }
    return await this.repository.existsInReadList(data.readListId, data.resourceId);
  }

  /**
   * Vérifie si un item avec la ressource donnée existe déjà dans cette read list (pour la mise à jour)
   * @param id ID de l'item à mettre à jour
   * @param data Données de mise à jour
   * @returns true si un autre item avec la même ressource existe déjà, false sinon
   */
  protected async checkExistsForUpdate(id: number, data: ReadListItemUpdateInput): Promise<boolean> {
    // Pour les items, on ne vérifie pas les doublons sur les mises à jour
    // car on ne change pas la ressource ou la read list
    return false;
  }

  /**
   * Vérifie si un item peut être supprimé
   * @param id ID de l'item à supprimer
   * @throws Erreur si l'item ne peut pas être supprimé
   */
  protected async checkCanDelete(id: number): Promise<void> {
    // Les items peuvent toujours être supprimés
    return;
  }

  /**
   * Ajoute une ressource à une read list
   * @param data Données de l'item à créer
   * @param userId ID de l'utilisateur demandeur
   * @returns Item créé
   * @throws Erreur si pas d'accès ou ressource/read list non trouvée
   */
  async addResourceToReadList(data: ReadListItemCreateInput, userId: number): Promise<ReadListItemResponse> {
    try {
      return await transactionService.execute(async (tx) => {
        this.repository.setPrismaClient(tx);
        readListRepository.setPrismaClient(tx);
        educationalResourceRepository.setPrismaClient(tx);

        // Vérifier que la read list existe et que l'utilisateur y a accès
        if (!data.readListId) {
          throw new ReadListItemValidationError('readListId is required');
        }

        const readList = await readListRepository.findById(data.readListId);
        if (!readList) {
          throw new ReadListNotFoundError();
        }

        if (!await readListRepository.hasAccess(data.readListId, userId)) {
          throw new ReadListPermissionError();
        }

        // Vérifier que la ressource éducative existe
        const resource = await educationalResourceRepository.findById(data.resourceId);
        if (!resource) {
          throw new ReadListResourceNotFoundError();
        }

        // Créer l'item
        return await this.create(data);
      });
    } catch (error) {
      throw error;
    } finally {
      this.repository.resetPrismaClient();
      readListRepository.resetPrismaClient();
      educationalResourceRepository.resetPrismaClient();
    }
  }

  /**
   * Récupère tous les items d'une read list avec vérification des permissions
   * @param readListId ID de la read list
   * @param userId ID de l'utilisateur demandeur
   * @param query Paramètres de requête
   * @returns Liste paginée des items
   */
  async getByReadListWithPermission(
    readListId: number,
    userId: number,
    query: ReadListItemQueryParams = {}
  ) {
    try {
      // Vérifier l'accès à la read list
      if (!await readListRepository.hasAccess(readListId, userId)) {
        throw new ReadListPermissionError();
      }

      const validatedQuery = this.validateInput(query, this.validationSchemas.query);

      const cacheKey = CACHE_KEYS.READLIST_ITEMS_BY_LIST(readListId) + `:${JSON.stringify(validatedQuery)}`;

      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const result = await this.repository.findByReadList(readListId, validatedQuery);
          logDeduplicator.info('Read list items retrieved successfully', {
            readListId,
            userId,
            count: result.data.length,
            total: result.pagination.total
          });
          return result;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      if (error instanceof ReadListPermissionError) {
        throw error;
      }
      logDeduplicator.error('Error fetching read list items with permission:', { error, readListId, userId });
      throw error;
    }
  }

  /**
   * Marque un item comme lu/non lu
   * @param itemId ID de l'item
   * @param userId ID de l'utilisateur demandeur
   * @param isRead Statut de lecture
   * @returns Item mis à jour + XP accordé
   */
  async toggleReadStatus(itemId: number, userId: number, isRead: boolean): Promise<{ item: ReadListItemResponse; xpGranted: number }> {
    try {
      const result = await transactionService.execute(async (tx) => {
        this.repository.setPrismaClient(tx);
        readListRepository.setPrismaClient(tx);

        // Vérifier que l'item existe
        const item = await this.repository.findById(itemId);
        if (!item) {
          throw new ReadListItemNotFoundError();
        }

        // Vérifier l'accès à la read list
        if (!await readListRepository.hasAccess(item.readListId, userId)) {
          throw new ReadListPermissionError();
        }

        // Mettre à jour le statut
        const updatedItem = await this.repository.toggleReadStatus(itemId, isRead);

        // Invalider les caches
        await this.invalidateReadListItemCache(itemId, item.readListId);

        return { updatedItem, wasUnread: !item.isRead };
      });

      let xpGranted = 0;

      // Attribuer l'XP si marqué comme lu (et n'était pas déjà lu)
      if (isRead && result.wasUnread) {
        try {
          xpGranted = await xpService.grantXp({
            userId,
            actionType: 'MARK_RESOURCE_READ',
            referenceId: `readitem-${itemId}`,
            description: 'Marked resource as read',
          });
          
          // Compléter la daily task READ_RESOURCE
          await xpService.completeDailyTask(userId, 'READ_RESOURCE');
        } catch (xpError) {
          logDeduplicator.warn('Failed to grant XP for marking resource as read', {
            userId,
            itemId,
            error: xpError instanceof Error ? xpError.message : String(xpError),
          });
        }
      }

      return { item: result.updatedItem, xpGranted };
    } catch (error) {
      throw error;
    } finally {
      this.repository.resetPrismaClient();
      readListRepository.resetPrismaClient();
    }
  }

  /**
   * Réorganise l'ordre des items dans une read list
   * @param readListId ID de la read list
   * @param userId ID de l'utilisateur demandeur
   * @param itemOrders Nouveau ordre des items
   */
  async reorderItems(
    readListId: number,
    userId: number,
    itemOrders: { id: number; order: number }[]
  ): Promise<void> {
    try {
      return await transactionService.execute(async (tx) => {
        this.repository.setPrismaClient(tx);
        readListRepository.setPrismaClient(tx);

        // Vérifier l'accès à la read list
        if (!await readListRepository.hasAccess(readListId, userId)) {
          throw new ReadListPermissionError();
        }

        // Réorganiser les items
        await this.repository.reorderItems(readListId, itemOrders);

        // Invalider les caches
        await this.invalidateReadListItemsCache(readListId);

        logDeduplicator.info('Read list items reordered successfully', {
          readListId,
          userId,
          itemsCount: itemOrders.length
        });
      });
    } catch (error) {
      throw error;
    } finally {
      this.repository.resetPrismaClient();
      readListRepository.resetPrismaClient();
    }
  }

  /**
   * Supprime un item avec vérification des permissions
   * @param itemId ID de l'item
   * @param userId ID de l'utilisateur demandeur
   */
  async deleteWithPermission(itemId: number, userId: number): Promise<void> {
    try {
      return await transactionService.execute(async (tx) => {
        this.repository.setPrismaClient(tx);
        readListRepository.setPrismaClient(tx);

        // Vérifier que l'item existe
        const item = await this.repository.findById(itemId);
        if (!item) {
          throw new ReadListItemNotFoundError();
        }

        // Vérifier l'accès à la read list
        if (!await readListRepository.hasAccess(item.readListId, userId)) {
          throw new ReadListPermissionError();
        }

        // Supprimer l'item
        await this.delete(itemId);

        logDeduplicator.info('Read list item deleted successfully', { itemId, userId });
      });
    } catch (error) {
      throw error;
    } finally {
      this.repository.resetPrismaClient();
      readListRepository.resetPrismaClient();
    }
  }

  /**
   * Invalide le cache spécifique aux items d'une read list
   * @param itemId ID de l'item
   * @param readListId ID de la read list
   */
  protected async invalidateReadListItemCache(itemId: number, readListId: number): Promise<void> {
    await Promise.all([
      this.invalidateEntityCache(itemId),
      this.invalidateReadListItemsCache(readListId)
    ]);
  }

  /**
   * Invalide le cache de tous les items d'une read list
   * @param readListId ID de la read list
   */
  protected async invalidateReadListItemsCache(readListId: number): Promise<void> {
    await cacheService.invalidateByPattern(`${CACHE_PREFIX.READLIST_ITEM}:list:${readListId}:*`);
  }

  /**
   * Override de la méthode create pour invalider les caches spécifiques
   */
  async create(data: ReadListItemCreateInput): Promise<ReadListItemResponse> {
    const result = await super.create(data);
    if (data.readListId) {
      await this.invalidateReadListItemCache(result.id, data.readListId);
    }
    return result;
  }

  /**
   * Override de la méthode update pour invalider les caches spécifiques
   */
  async update(id: number, data: ReadListItemUpdateInput): Promise<ReadListItemResponse> {
    const existingItem = await this.repository.findById(id);
    const result = await super.update(id, data);
    if (existingItem) {
      await this.invalidateReadListItemCache(id, existingItem.readListId);
    }
    return result;
  }

  /**
   * Override de la méthode delete pour invalider les caches spécifiques
   */
  async delete(id: number): Promise<void> {
    const existingItem = await this.repository.findById(id);
    await super.delete(id);
    if (existingItem) {
      await this.invalidateReadListItemCache(id, existingItem.readListId);
    }
  }
} 