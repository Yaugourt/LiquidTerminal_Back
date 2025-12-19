import {
  ReadListResponse,
  ReadListCreateInput,
  ReadListUpdateInput,
  ReadListSummaryResponse
} from '../../types/readlist.types';
import {
  ReadListNotFoundError,
  ReadListAlreadyExistsError,
  ReadListValidationError,
  ReadListPermissionError,
  ReadListError
} from '../../errors/readlist.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { CACHE_PREFIX, CACHE_KEYS } from '../../constants/cache.constants';
import {
  readListCreateSchema,
  readListUpdateSchema,
  readListQuerySchema
} from '../../schemas/readlist.schema';
import { readListRepository } from '../../repositories';
import { BaseService } from '../../core/crudBase.service';
import { cacheService } from '../../core/cache.service';
import { CACHE_TTL } from '../../constants/cache.constants';
import { ReadListItemService } from './readlist-item.service';
import { xpService } from '../xp/xp.service';

// Type pour les paramètres de requête
type ReadListQueryParams = {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  userId?: number;
  isPublic?: boolean;
};

export class ReadListService extends BaseService<
  ReadListResponse,
  ReadListCreateInput,
  ReadListUpdateInput,
  ReadListQueryParams
> {
  protected repository = readListRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.READLIST;
  protected validationSchemas = {
    create: readListCreateSchema,
    update: readListUpdateSchema,
    query: readListQuerySchema
  };
  protected errorClasses = {
    notFound: ReadListNotFoundError,
    alreadyExists: ReadListAlreadyExistsError,
    validation: ReadListValidationError
  };

  /**
   * Vérifie si une read list avec le nom donné existe déjà pour cet utilisateur
   * @param data Données de la read list
   * @returns true si la read list existe déjà, false sinon
   */
  protected async checkExists(data: ReadListCreateInput): Promise<boolean> {
    return await this.repository.existsByNameAndUser(data.name, data.userId);
  }

  /**
   * Vérifie si une read list avec le nom donné existe déjà pour cet utilisateur (pour la mise à jour)
   * @param id ID de la read list à mettre à jour
   * @param data Données de mise à jour
   * @returns true si une autre read list avec le même nom existe déjà, false sinon
   */
  protected async checkExistsForUpdate(id: number, data: ReadListUpdateInput): Promise<boolean> {
    if (data.name) {
      const readList = await this.repository.findById(id);
      if (readList && data.name !== readList.name) {
        return await this.repository.existsByNameAndUser(data.name, readList.userId);
      }
    }
    return false;
  }

  /**
   * Vérifie si une read list peut être supprimée
   * @param id ID de la read list à supprimer
   * @throws Erreur si la read list ne peut pas être supprimée
   */
  protected async checkCanDelete(id: number): Promise<void> {
    // Les read lists peuvent toujours être supprimées
    // Les items seront supprimés en cascade grâce à la contrainte de la DB
    return;
  }

  /**
   * Vérifie si un utilisateur a accès à une read list
   * @param readListId ID de la read list
   * @param userId ID de l'utilisateur
   * @returns true si l'utilisateur a accès, false sinon
   */
  async hasAccess(readListId: number, userId: number): Promise<boolean> {
    try {
      return await cacheService.getOrSet(
        `${CACHE_PREFIX.READLIST}:access:${readListId}:${userId}`,
        async () => {
          const hasAccess = await this.repository.hasAccess(readListId, userId);
          logDeduplicator.info('ReadList access check completed', { readListId, userId, hasAccess });
          return hasAccess;
        },
        CACHE_TTL.SHORT // Cache court pour les permissions
      );
    } catch (error) {
      logDeduplicator.error('Error checking read list access:', { error, readListId, userId });
      return false;
    }
  }

  /**
   * Récupère une read list avec vérification des permissions
   * @param id ID de la read list
   * @param userId ID de l'utilisateur demandeur
   * @returns Read list si accessible
   * @throws Erreur si pas d'accès ou read list non trouvée
   */
  async getByIdWithPermission(id: number, userId: number): Promise<ReadListResponse> {
    try {
      const readList = await this.getById(id);

      if (!await this.hasAccess(id, userId)) {
        throw new ReadListPermissionError();
      }

      return readList;
    } catch (error) {
      if (error instanceof ReadListNotFoundError || error instanceof ReadListPermissionError) {
        throw error;
      }
      logDeduplicator.error('Error fetching read list with permission:', { error, id, userId });
      throw error;
    }
  }

  /**
   * Récupère toutes les read lists d'un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Liste des read lists de l'utilisateur
   */
  async getByUser(userId: number): Promise<ReadListSummaryResponse[]> {
    try {
      return await cacheService.getOrSet(
        CACHE_KEYS.READLIST_BY_USER(userId),
        async () => {
          const readLists = await this.repository.findByUser(userId);
          logDeduplicator.info('Read lists by user retrieved successfully', {
            userId,
            count: readLists.length
          });
          return readLists;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      logDeduplicator.error('Error fetching read lists by user:', { error, userId });
      throw error;
    }
  }

  /**
   * Récupère toutes les read lists publiques
   * @param query Paramètres de requête
   * @returns Liste paginée des read lists publiques
   */
  async getPublicLists(query: ReadListQueryParams) {
    try {
      const validatedQuery = this.validateInput(query, this.validationSchemas.query);

      const cacheKey = `${this.cacheKeyPrefix}:public:list:${JSON.stringify(validatedQuery)}`;

      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const result = await this.repository.findPublicLists(validatedQuery);
          logDeduplicator.info('Public read lists retrieved successfully', {
            count: result.data.length,
            total: result.pagination.total
          });
          return result;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      logDeduplicator.error('Error fetching public read lists:', { error, query });
      throw error;
    }
  }

  /**
   * Invalide le cache spécifique aux read lists
   * @param id ID de la read list
   * @param userId ID de l'utilisateur (pour invalider le cache utilisateur)
   */
  protected async invalidateReadListCache(id: number, userId?: number): Promise<void> {
    await Promise.all([
      this.invalidateEntityCache(id),
      cacheService.invalidateByPattern(`${CACHE_PREFIX.READLIST}:access:${id}:*`),
      userId ? cacheService.invalidate(CACHE_KEYS.READLIST_BY_USER(userId)) : Promise.resolve(),
      cacheService.invalidateByPattern(`${CACHE_PREFIX.READLIST}:public:*`)
    ]);
  }

  /**
   * Override de la méthode create pour invalider les caches spécifiques et attribuer XP
   */
  async create(data: ReadListCreateInput): Promise<ReadListResponse> {
    const result = await super.create(data);
    await this.invalidateReadListCache(result.id, data.userId);

    // Attribuer l'XP pour création de readlist
    try {
      await xpService.grantXp({
        userId: data.userId,
        actionType: 'CREATE_READLIST',
        referenceId: `readlist-${result.id}`,
        description: `Created read list: ${data.name}`,
      });

      // Bonus pour liste publique
      if (data.isPublic) {
        await xpService.grantXp({
          userId: data.userId,
          actionType: 'CREATE_PUBLIC_LIST_BONUS' as any,
          referenceId: `readlist-public-${result.id}`,
          description: `Public bonus for read list: ${data.name}`,
        });
      }
    } catch (error) {
      logDeduplicator.warn('Failed to grant XP for readlist creation', {
        userId: data.userId,
        readListId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  }

  /**
   * Override de la méthode update pour invalider les caches spécifiques
   */
  async update(id: number, data: ReadListUpdateInput): Promise<ReadListResponse> {
    const existingReadList = await this.repository.findById(id);
    const result = await super.update(id, data);
    await this.invalidateReadListCache(id, existingReadList?.userId);
    return result;
  }

  /**
   * Override de la méthode delete pour invalider les caches spécifiques
   */
  async delete(id: number): Promise<void> {
    const existingReadList = await this.repository.findById(id);
    await super.delete(id);
    await this.invalidateReadListCache(id, existingReadList?.userId);
  }

  /**
   * Copie une read list publique dans les read lists de l'utilisateur
   * @param readListId ID de la read list à copier
   * @param userId ID de l'utilisateur qui copie
   * @returns La nouvelle read list copiée
   */
  async copyReadList(readListId: number, userId: number): Promise<ReadListResponse> {
    try {
      logDeduplicator.info('Copying read list', { readListId, userId });

      // 1. Récupérer la read list originale avec ses items
      const originalReadList = await this.repository.findById(readListId);
      if (!originalReadList) {
        throw new ReadListNotFoundError();
      }

      // 2. Vérifier que la read list est publique
      if (!originalReadList.isPublic) {
        throw new ReadListError('Cannot copy private read list', 403, 'ACCESS_DENIED');
      }

      // 3. Vérifier que l'utilisateur ne copie pas sa propre read list
      if (originalReadList.creator.id === userId) {
        throw new ReadListError('Cannot copy your own read list', 400, 'INVALID_OPERATION');
      }

      // 4. Créer une nouvelle read list avec un nom unique
      const newName = `${originalReadList.name} (Copy)`;
      const newDescription = originalReadList.description ?
        `${originalReadList.description}\n\nCopied from: ${originalReadList.creator.name}` :
        `Copied from: ${originalReadList.creator.name}`;

      const newReadList = await this.create({
        name: newName,
        description: newDescription,
        userId: userId,
        isPublic: false // Par défaut, la copie est privée
      });

      // 5. Copier tous les items de la read list originale
      if (originalReadList.items && originalReadList.items.length > 0) {
        const readListItemService = new ReadListItemService();

        for (const item of originalReadList.items) {
          await readListItemService.create({
            readListId: newReadList.id,
            resourceId: item.resource.id,
            notes: item.notes || undefined,
            order: item.order || undefined
          });
        }

        logDeduplicator.info('Read list items copied successfully', {
          originalReadListId: readListId,
          newReadListId: newReadList.id,
          itemsCount: originalReadList.items.length
        });
      }

      // 6. Récupérer la read list complète avec les items copiés
      const completeReadList = await this.repository.findById(newReadList.id);
      if (!completeReadList) {
        throw new ReadListError('Failed to retrieve copied read list', 500, 'INTERNAL_ERROR');
      }

      // Attribuer l'XP pour copie de readlist publique
      try {
        await xpService.grantXp({
          userId,
          actionType: 'COPY_PUBLIC_READLIST',
          referenceId: `copy-${readListId}-to-${newReadList.id}`,
          description: `Copied public read list: ${originalReadList.name}`,
        });
      } catch (xpError) {
        logDeduplicator.warn('Failed to grant XP for readlist copy', {
          userId,
          originalReadListId: readListId,
          newReadListId: newReadList.id,
          error: xpError instanceof Error ? xpError.message : String(xpError),
        });
      }

      logDeduplicator.info('Read list copied successfully', {
        originalReadListId: readListId,
        newReadListId: newReadList.id,
        userId
      });

      return completeReadList;
    } catch (error) {
      logDeduplicator.error('Error copying read list:', { error, readListId, userId });
      throw error;
    }
  }
} 