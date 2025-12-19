import {
  WalletListResponse,
  WalletListCreateInput,
  WalletListUpdateInput,
  WalletListSummaryResponse
} from '../../types/walletlist.types';
import {
  WalletListNotFoundError,
  WalletListAlreadyExistsError,
  WalletListValidationError,
  WalletListPermissionError,
  WalletListError
} from '../../errors/walletlist.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { CACHE_PREFIX, CACHE_KEYS } from '../../constants/cache.constants';
import {
  walletListCreateSchema,
  walletListUpdateSchema,
  walletListQuerySchema
} from '../../schemas/walletlist.schema';
import { BaseService } from '../../core/crudBase.service';
import { cacheService } from '../../core/cache.service';
import { CACHE_TTL } from '../../constants/cache.constants';
import { PrismaWalletListRepository } from '../../repositories/prisma/prisma.walletlist.repository';
import { WalletListItemService } from './walletlist-item.service';
import { xpService } from '../xp/xp.service';

// Type pour les paramètres de requête
type WalletListQueryParams = {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  userId?: number;
  isPublic?: boolean;
};

export class WalletListService extends BaseService<
  WalletListResponse,
  WalletListCreateInput,
  WalletListUpdateInput,
  WalletListQueryParams
> {
  protected repository = new PrismaWalletListRepository();
  protected cacheKeyPrefix = CACHE_PREFIX.WALLETLIST;
  protected validationSchemas = {
    create: walletListCreateSchema,
    update: walletListUpdateSchema,
    query: walletListQuerySchema
  };
  protected errorClasses = {
    notFound: WalletListNotFoundError,
    alreadyExists: WalletListAlreadyExistsError,
    validation: WalletListValidationError
  };

  /**
   * Vérifie si une wallet list avec le nom donné existe déjà pour cet utilisateur
   * @param data Données de la wallet list
   * @returns true si la wallet list existe déjà, false sinon
   */
  protected async checkExists(data: WalletListCreateInput): Promise<boolean> {
    return await this.repository.existsByNameAndUser(data.name, data.userId);
  }

  /**
   * Vérifie si une wallet list avec le nom donné existe déjà pour cet utilisateur (pour la mise à jour)
   * @param id ID de la wallet list à mettre à jour
   * @param data Données de mise à jour
   * @returns true si une autre wallet list avec le même nom existe déjà, false sinon
   */
  protected async checkExistsForUpdate(id: number, data: WalletListUpdateInput): Promise<boolean> {
    if (data.name) {
      const walletList = await this.repository.findById(id);
      if (walletList && data.name !== walletList.name) {
        return await this.repository.existsByNameAndUser(data.name, walletList.userId);
      }
    }
    return false;
  }

  /**
   * Vérifie si une wallet list peut être supprimée
   * @param id ID de la wallet list à supprimer
   * @throws Erreur si la wallet list ne peut pas être supprimée
   */
  protected async checkCanDelete(id: number): Promise<void> {
    // Les wallet lists peuvent toujours être supprimées
    // Les items seront supprimés en cascade grâce à la contrainte de la DB
    return;
  }

  /**
   * Vérifie si un utilisateur a accès à une wallet list
   * @param walletListId ID de la wallet list
   * @param userId ID de l'utilisateur
   * @returns true si l'utilisateur a accès, false sinon
   */
  async hasAccess(walletListId: number, userId: number): Promise<boolean> {
    try {
      return await cacheService.getOrSet(
        `${this.cacheKeyPrefix}:access:${walletListId}:${userId}`,
        async () => {
          const hasAccess = await this.repository.hasAccess(walletListId, userId);
          logDeduplicator.info('WalletList access check completed', { walletListId, userId, hasAccess });
          return hasAccess;
        },
        CACHE_TTL.SHORT // Cache court pour les permissions
      );
    } catch (error) {
      logDeduplicator.error('Error checking wallet list access:', { error, walletListId, userId });
      return false;
    }
  }

  /**
   * Récupère une wallet list avec vérification des permissions
   * @param id ID de la wallet list
   * @param userId ID de l'utilisateur demandeur
   * @returns Wallet list si accessible
   * @throws Erreur si pas d'accès ou wallet list non trouvée
   */
  async getByIdWithPermission(id: number, userId: number): Promise<WalletListResponse> {
    try {
      const walletList = await this.getById(id);

      if (!await this.hasAccess(id, userId)) {
        throw new WalletListPermissionError();
      }

      return walletList;
    } catch (error) {
      if (error instanceof WalletListNotFoundError || error instanceof WalletListPermissionError) {
        throw error;
      }
      logDeduplicator.error('Error fetching wallet list with permission:', { error, id, userId });
      throw error;
    }
  }

  /**
   * Récupère toutes les wallet lists d'un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Liste des wallet lists de l'utilisateur
   */
  async getByUser(userId: number): Promise<WalletListSummaryResponse[]> {
    try {
      return await cacheService.getOrSet(
        CACHE_KEYS.WALLETLIST_BY_USER(userId),
        async () => {
          const walletLists = await this.repository.findByUser(userId);
          logDeduplicator.info('Wallet lists by user retrieved successfully', {
            userId,
            count: walletLists.length
          });
          return walletLists;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      logDeduplicator.error('Error fetching wallet lists by user:', { error, userId });
      throw error;
    }
  }

  /**
   * Récupère toutes les wallet lists publiques
   * @param query Paramètres de requête
   * @returns Liste paginée des wallet lists publiques
   */
  async getPublicLists(query: WalletListQueryParams) {
    try {
      const validatedQuery = this.validateInput(query, this.validationSchemas.query);

      const cacheKey = `${this.cacheKeyPrefix}:public:list:${JSON.stringify(validatedQuery)}`;

      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const result = await this.repository.findPublicLists(validatedQuery);
          logDeduplicator.info('Public wallet lists retrieved successfully', {
            count: result.data.length,
            total: result.pagination.total
          });
          return result;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      logDeduplicator.error('Error fetching public wallet lists:', { error, query });
      throw error;
    }
  }

  /**
   * Invalide le cache spécifique aux wallet lists
   * @param id ID de la wallet list
   * @param userId ID de l'utilisateur (pour invalider le cache utilisateur)
   */
  protected async invalidateWalletListCache(id: number, userId?: number): Promise<void> {
    await Promise.all([
      this.invalidateEntityCache(id),
      cacheService.invalidateByPattern(`${this.cacheKeyPrefix}:access:${id}:*`),
      userId ? cacheService.invalidate(CACHE_KEYS.WALLETLIST_BY_USER(userId)) : Promise.resolve(),
      cacheService.invalidateByPattern(`${this.cacheKeyPrefix}:public:*`)
    ]);
  }

  /**
   * Override de la méthode create pour invalider les caches spécifiques et attribuer XP
   */
  async create(data: WalletListCreateInput): Promise<WalletListResponse> {
    const result = await super.create(data);
    await this.invalidateWalletListCache(result.id, data.userId);

    // Attribuer l'XP pour création de wallet list
    try {
      await xpService.grantXp({
        userId: data.userId,
        actionType: 'CREATE_WALLETLIST',
        referenceId: `walletlist-${result.id}`,
        description: `Created wallet list: ${data.name}`,
      });

      // Bonus pour liste publique
      if (data.isPublic) {
        await xpService.grantXp({
          userId: data.userId,
          actionType: 'CREATE_PUBLIC_LIST_BONUS' as any,
          referenceId: `walletlist-public-${result.id}`,
          description: `Public bonus for wallet list: ${data.name}`,
        });
      }
    } catch (error) {
      logDeduplicator.warn('Failed to grant XP for wallet list creation', {
        userId: data.userId,
        walletListId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  }

  /**
   * Override de la méthode update pour invalider les caches spécifiques
   */
  async update(id: number, data: WalletListUpdateInput): Promise<WalletListResponse> {
    const existingWalletList = await this.repository.findById(id);
    const result = await super.update(id, data);
    await this.invalidateWalletListCache(id, existingWalletList?.userId);
    return result;
  }

  /**
   * Override de la méthode delete pour invalider les caches spécifiques
   */
  async delete(id: number): Promise<void> {
    const existingWalletList = await this.repository.findById(id);
    await super.delete(id);
    await this.invalidateWalletListCache(id, existingWalletList?.userId);
  }

  /**
   * Copie une wallet list publique dans les wallet lists de l'utilisateur
   * @param walletListId ID de la wallet list à copier
   * @param userId ID de l'utilisateur qui copie
   * @returns La nouvelle wallet list copiée
   */
  async copyWalletList(walletListId: number, userId: number): Promise<WalletListResponse> {
    try {
      logDeduplicator.info('Copying wallet list', { walletListId, userId });

      // 1. Récupérer la wallet list originale avec ses items
      const originalWalletList = await this.repository.findById(walletListId);
      if (!originalWalletList) {
        throw new WalletListNotFoundError();
      }

      // 2. Vérifier que la wallet list est publique
      if (!originalWalletList.isPublic) {
        throw new WalletListError('Cannot copy private wallet list', 403, 'ACCESS_DENIED');
      }

      // 3. Vérifier que l'utilisateur ne copie pas sa propre wallet list
      if (originalWalletList.creator.id === userId) {
        throw new WalletListError('Cannot copy your own wallet list', 400, 'INVALID_OPERATION');
      }

      // 4. Créer une nouvelle wallet list avec un nom unique
      const newName = `${originalWalletList.name} (Copy)`;
      const newDescription = originalWalletList.description ?
        `${originalWalletList.description}\n\nCopied from: ${originalWalletList.creator.name}` :
        `Copied from: ${originalWalletList.creator.name}`;

      const newWalletList = await this.create({
        name: newName,
        description: newDescription,
        userId: userId,
        isPublic: false // Par défaut, la copie est privée
      });

      // 5. Copier tous les items de la wallet list originale
      if (originalWalletList.items && originalWalletList.items.length > 0) {
        const walletListItemService = new WalletListItemService();
        const { userWalletRepository } = await import('../../repositories/userWallet.repository');

        for (const item of originalWalletList.items) {
          const originalWallet = item.userWallet.Wallet;

          // A. Vérifier si le copieur a déjà ce wallet dans ses UserWallet
          let copierUserWallet = await userWalletRepository.findByUserAndWallet(
            userId,
            originalWallet.id
          );

          // B. Si non, créer un UserWallet pour le copieur
          if (!copierUserWallet) {
            copierUserWallet = await userWalletRepository.create({
              userId: userId,
              walletId: originalWallet.id,
              name: item.userWallet.name || undefined  // Garder le nom original
            });

            logDeduplicator.info('Created UserWallet for copier', {
              userId,
              walletId: originalWallet.id,
              userWalletId: copierUserWallet.id
            });
          }

          // C. Créer le WalletListItem avec le userWalletId DU COPIEUR
          await walletListItemService.create({
            walletListId: newWalletList.id,
            userWalletId: copierUserWallet.id,  // ← ID du copieur maintenant
            notes: item.notes || undefined,
            order: item.order || undefined
          });
        }

        logDeduplicator.info('Wallet list items copied successfully', {
          originalWalletListId: walletListId,
          newWalletListId: newWalletList.id,
          itemsCount: originalWalletList.items.length
        });
      }

      // 6. Récupérer la wallet list complète avec les items copiés
      const completeWalletList = await this.repository.findById(newWalletList.id);
      if (!completeWalletList) {
        throw new WalletListError('Failed to retrieve copied wallet list', 500, 'INTERNAL_ERROR');
      }

      logDeduplicator.info('Wallet list copied successfully', {
        originalWalletListId: walletListId,
        newWalletListId: newWalletList.id,
        userId
      });

      return completeWalletList;
    } catch (error) {
      logDeduplicator.error('Error copying wallet list:', { error, walletListId, userId });
      throw error;
    }
  }
}
