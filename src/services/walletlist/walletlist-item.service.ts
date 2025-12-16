import { 
  WalletListItemResponse, 
  WalletListItemCreateInput, 
  WalletListItemUpdateInput
} from '../../types/walletlist.types';
import { 
  WalletListItemNotFoundError, 
  WalletListItemAlreadyExistsError,
  WalletListItemValidationError,
  WalletListUserWalletNotFoundError,
  WalletListNotFoundError
} from '../../errors/walletlist.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { CACHE_PREFIX } from '../../constants/cache.constants';
import { 
  walletListItemCreateSchema, 
  walletListItemUpdateSchema, 
  walletListItemQuerySchema 
} from '../../schemas/walletlist.schema';
import { BaseService } from '../../core/crudBase.service';
import { cacheService } from '../../core/cache.service';
import { CACHE_TTL } from '../../constants/cache.constants';
import { PrismaWalletListItemRepository } from '../../repositories/prisma/prisma.walletlist-item.repository';
import { PrismaWalletListRepository } from '../../repositories/prisma/prisma.walletlist.repository';
import { prisma } from '../../core/prisma.service';
import { xpService } from '../xp/xp.service';

// Type pour les paramètres de requête
type WalletListItemQueryParams = {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  walletListId?: number;
};

export class WalletListItemService extends BaseService<
  WalletListItemResponse, 
  WalletListItemCreateInput, 
  WalletListItemUpdateInput, 
  WalletListItemQueryParams
> {
  protected repository = new PrismaWalletListItemRepository();
  private walletListRepository = new PrismaWalletListRepository();
  protected cacheKeyPrefix = `${CACHE_PREFIX.READLIST}:wallet:item`; // Réutiliser le prefix readlist pour la cohérence
  protected validationSchemas = {
    create: walletListItemCreateSchema,
    update: walletListItemUpdateSchema,
    query: walletListItemQuerySchema
  };
  protected errorClasses = {
    notFound: WalletListItemNotFoundError,
    alreadyExists: WalletListItemAlreadyExistsError,
    validation: WalletListItemValidationError
  };

  /**
   * Vérifie si un userWallet existe déjà dans une wallet list
   * @param data Données du wallet list item
   * @returns true si le userWallet existe déjà dans la liste, false sinon
   */
  protected async checkExists(data: WalletListItemCreateInput): Promise<boolean> {
    if (!data.walletListId) return false;
    return await this.repository.existsInWalletList(data.walletListId, data.userWalletId);
  }

  /**
   * Vérifie si un wallet list item avec les données de mise à jour existe déjà
   * @param id ID du wallet list item à mettre à jour
   * @param data Données de mise à jour
   * @returns true si une autre entité avec les mêmes données existe déjà, false sinon
   */
  protected async checkExistsForUpdate(id: number, data: WalletListItemUpdateInput): Promise<boolean> {
    // Pour les wallet list items, on ne vérifie pas de doublons lors de la mise à jour
    // car on ne peut pas avoir de doublons de userWallet dans une même liste
    return false;
  }

  /**
   * Vérifie si un wallet list item peut être supprimé
   * @param id ID du wallet list item à supprimer
   * @throws Erreur si le wallet list item ne peut pas être supprimé
   */
  protected async checkCanDelete(id: number): Promise<void> {
    // Les wallet list items peuvent toujours être supprimés
    return;
  }

  /**
   * Valide les données avant création d'un wallet list item
   * @param data Données du wallet list item
   * @throws Erreur si les données ne sont pas valides
   */
  protected async validateCreateData(data: WalletListItemCreateInput): Promise<void> {
    // Vérifier que la wallet list existe
    if (data.walletListId) {
      const walletList = await this.walletListRepository.findById(data.walletListId);
      if (!walletList) {
        throw new WalletListNotFoundError();
      }
    }

    // Vérifier que le userWallet existe
    const userWallet = await prisma.userWallet.findUnique({
      where: { id: data.userWalletId }
    });
    if (!userWallet) {
      throw new WalletListUserWalletNotFoundError();
    }
  }

  /**
   * Override de la méthode create pour ajouter la validation, gérer l'ordre et attribuer XP
   */
  async create(data: WalletListItemCreateInput): Promise<WalletListItemResponse> {
    try {
      // Validation des données
      await this.validateCreateData(data);

      // Si aucun ordre n'est spécifié, utiliser le prochain ordre disponible
      let finalData = { ...data };
      if (finalData.order === undefined && finalData.walletListId) {
        finalData.order = await this.repository.getNextOrder(finalData.walletListId);
      }

      const result = await super.create(finalData);
      
      // Invalider le cache de la wallet list parent
      if (data.walletListId) {
        await this.invalidateWalletListItemCache(data.walletListId);
        
        // Attribuer l'XP pour ajout de wallet à la liste
        // Récupérer le userId via la wallet list
        const walletList = await this.walletListRepository.findById(data.walletListId);
        if (walletList) {
          try {
            await xpService.grantXp({
              userId: walletList.userId,
              actionType: 'ADD_WALLET_TO_LIST',
              referenceId: `walletlistitem-${result.id}`,
              description: 'Added wallet to list',
            });
            
            // Compléter la daily task ADD_WALLET
            await xpService.completeDailyTask(walletList.userId, 'ADD_WALLET');
          } catch (xpError) {
            logDeduplicator.warn('Failed to grant XP for adding wallet to list', {
              walletListId: data.walletListId,
              error: xpError instanceof Error ? xpError.message : String(xpError),
            });
          }
        }
      }

      return result;
    } catch (error) {
      logDeduplicator.error('Error creating wallet list item:', { error, data });
      throw error;
    }
  }

  /**
   * Récupère tous les items d'une wallet list avec vérification des permissions
   * @param walletListId ID de la wallet list
   * @param userId ID de l'utilisateur demandeur
   * @param query Paramètres de requête
   * @returns Items de la wallet list si accessible
   * @throws Erreur si pas d'accès ou wallet list non trouvée
   */
  async getByWalletListWithPermission(
    walletListId: number, 
    userId: number, 
    query: WalletListItemQueryParams = {}
  ) {
    try {
      // Vérifier l'accès à la wallet list
      const hasAccess = await this.walletListRepository.hasAccess(walletListId, userId);
      if (!hasAccess) {
        throw new WalletListNotFoundError(); // On retourne "not found" plutôt que "permission denied" pour la sécurité
      }

      const validatedQuery = this.validateInput({ ...query, walletListId }, this.validationSchemas.query);

      const cacheKey = `${this.cacheKeyPrefix}:list:${walletListId}:${JSON.stringify(validatedQuery)}`;

      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const result = await this.repository.findByWalletList(walletListId, validatedQuery);
          logDeduplicator.info('Wallet list items by wallet list retrieved successfully', {
            walletListId,
            count: result.data.length,
            total: result.pagination.total
          });
          return result;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      logDeduplicator.error('Error fetching wallet list items by wallet list:', { error, walletListId, userId });
      throw error;
    }
  }

  /**
   * Réorganise l'ordre des items dans une wallet list
   * @param walletListId ID de la wallet list
   * @param itemOrders Tableau des nouveaux ordres
   * @param userId ID de l'utilisateur demandeur
   */
  async reorderItems(
    walletListId: number, 
    itemOrders: { id: number; order: number }[], 
    userId: number
  ): Promise<void> {
    try {
      // Vérifier l'accès à la wallet list
      const hasAccess = await this.walletListRepository.hasAccess(walletListId, userId);
      if (!hasAccess) {
        throw new WalletListNotFoundError();
      }

      await this.repository.reorderItems(walletListId, itemOrders);
      await this.invalidateWalletListItemCache(walletListId);

      logDeduplicator.info('Wallet list items reordered successfully', {
        walletListId,
        itemsCount: itemOrders.length,
        userId
      });
    } catch (error) {
      logDeduplicator.error('Error reordering wallet list items:', { error, walletListId, itemOrders, userId });
      throw error;
    }
  }

  /**
   * Invalide le cache spécifique aux wallet list items
   * @param walletListId ID de la wallet list
   */
  protected async invalidateWalletListItemCache(walletListId: number): Promise<void> {
    await Promise.all([
      cacheService.invalidateByPattern(`${this.cacheKeyPrefix}:list:${walletListId}:*`),
      cacheService.invalidateByPattern(`${CACHE_PREFIX.READLIST}:wallet:${walletListId}:*`), // Cache de la wallet list parent
      cacheService.invalidateByPattern(`${CACHE_PREFIX.READLIST}:wallet:user:*`) // Cache des listes utilisateur
    ]);
  }

  /**
   * Override de la méthode update pour invalider les caches spécifiques
   */
  async update(id: number, data: WalletListItemUpdateInput): Promise<WalletListItemResponse> {
    const existingItem = await this.repository.findById(id);
    const result = await super.update(id, data);
    
    if (existingItem) {
      await this.invalidateWalletListItemCache(existingItem.walletListId);
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
      await this.invalidateWalletListItemCache(existingItem.walletListId);
    }
  }

  /**
   * Supprime un userWallet d'une wallet list
   * @param walletListId ID de la wallet list
   * @param userWalletId ID du userWallet
   * @param userId ID de l'utilisateur demandeur
   */
  async removeFromWalletList(walletListId: number, userWalletId: number, userId: number): Promise<void> {
    try {
      // Vérifier l'accès à la wallet list
      const hasAccess = await this.walletListRepository.hasAccess(walletListId, userId);
      if (!hasAccess) {
        throw new WalletListNotFoundError();
      }

      // Trouver l'item à supprimer
      const items = await this.repository.findByWalletList(walletListId);
      const itemToDelete = items.data.find(item => item.userWallet.id === userWalletId);
      
      if (!itemToDelete) {
        throw new WalletListItemNotFoundError();
      }

      await this.delete(itemToDelete.id);

      logDeduplicator.info('UserWallet removed from wallet list successfully', {
        walletListId,
        userWalletId,
        userId
      });
    } catch (error) {
      logDeduplicator.error('Error removing userWallet from wallet list:', { error, walletListId, userWalletId, userId });
      throw error;
    }
  }
}
