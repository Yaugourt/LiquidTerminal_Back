import { BaseService } from '../../core/crudBase.service';
import { walletRepository } from '../../repositories/wallet.repository';
import { userWalletRepository } from '../../repositories/userWallet.repository';
import { 
  WalletCreateInput, 
  WalletUpdateInput, 
  WalletResponse,
  WalletQueryParams,
  UserWalletResponse 
} from '../../types/wallet.types';
import { 
  WalletNotFoundError, 
  WalletAlreadyExistsError,
  WalletValidationError,
  UserNotFoundError
} from '../../errors/wallet.errors';
import { 
  walletCreateSchema, 
  walletUpdateSchema, 
  walletQuerySchema 
} from '../../schemas/wallet.schema';
import { CACHE_PREFIX } from '../../constants/cache.constants';
import { transactionService } from '../../core/transaction.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class WalletService extends BaseService<WalletResponse, WalletCreateInput, WalletUpdateInput, WalletQueryParams> {
  protected repository = walletRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.WALLET;
  protected validationSchemas = {
    create: walletCreateSchema,
    update: walletUpdateSchema,
    query: walletQuerySchema
  };
  protected errorClasses = {
    notFound: WalletNotFoundError,
    alreadyExists: WalletAlreadyExistsError,
    validation: WalletValidationError
  };

  /**
   * Valide une adresse Ethereum
   */
  private validateEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  protected async checkExists(data: WalletCreateInput): Promise<boolean> {
    return await this.repository.existsByAddress(data.address);
  }

  protected async checkExistsForUpdate(id: number, data: WalletUpdateInput): Promise<boolean> {
    return false; // Nous ne permettons pas de modifier l'adresse
  }

  protected async checkCanDelete(id: number): Promise<void> {
    // Vérifier si le wallet a des transactions
    // Cette méthode sera implémentée plus tard
  }

  /**
   * Ajoute un wallet pour un utilisateur
   */
  public async addWallet(privyUserId: string, address: string, name?: string) {
    try {
      // Validation de l'adresse Ethereum
      if (!this.validateEthereumAddress(address)) {
        throw new WalletValidationError('Invalid Ethereum address format');
      }

      // Utiliser le service de transaction pour l'ajout du wallet
      const userWallet = await transactionService.execute(async (tx) => {
        // Configurer les repositories pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx);
        userWalletRepository.setPrismaClient(tx);

        // Vérifier si l'utilisateur existe
        const user = await tx.user.findUnique({
          where: { privyUserId }
        });

        if (!user) {
          throw new UserNotFoundError();
        }

        // Vérifier si le wallet existe déjà
        let wallet = await this.repository.findByAddress(address);
        
        if (!wallet) {
          // Créer le wallet s'il n'existe pas
          wallet = await this.repository.create({
            address
          });
        } else {
          // Vérifier si l'utilisateur a déjà ce wallet
          const existingUserWallet = await userWalletRepository.findByUserAndWallet(user.id, wallet.id);
          if (existingUserWallet) {
            throw new WalletAlreadyExistsError();
          }
        }

        // Créer l'association utilisateur-wallet
        return await userWalletRepository.create({
          userId: user.id,
          walletId: wallet.id,
          name
        });
      });

      // Invalider le cache
      await this.invalidateEntityListCache();

      logDeduplicator.info('Wallet added successfully', { 
        address, 
        userId: userWallet.userId,
        walletId: userWallet.walletId
      });

      return userWallet;
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError || 
          error instanceof UserNotFoundError ||
          error instanceof WalletValidationError) {
        throw error;
      }
      logDeduplicator.error('Error adding wallet:', { 
        error, 
        privyUserId, 
        address,
        name
      });
      throw error;
    }
  }

  /**
   * Récupère les wallets d'un utilisateur avec pagination
   */
  public async getWalletsByUser(userId: number, page: number = 1, limit: number = 10) {
    try {
      const skip = (page - 1) * limit;
      
      // Utiliser le service de transaction pour la récupération des wallets
      const result = await transactionService.execute(async (tx) => {
        // Configurer les repositories pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx);
        userWalletRepository.setPrismaClient(tx);

        const [userWallets, total] = await Promise.all([
          userWalletRepository.findByUser(userId, { skip, take: limit }),
          userWalletRepository.countByUser(userId)
        ]);

        return { userWallets, total };
      });

      // Réinitialiser les clients Prisma
      this.repository.resetPrismaClient();
      userWalletRepository.resetPrismaClient();

      logDeduplicator.info('Wallets retrieved successfully', { 
        userId, 
        count: result.userWallets.length,
        total: result.total,
        page,
        limit
      });

      return {
        data: result.userWallets.map((uw: any) => ({
          id: uw.id,
          userId: uw.userId,
          walletId: uw.walletId,
          name: uw.name,
          addedAt: uw.addedAt,
          wallet: {
            id: uw.Wallet.id,
            address: uw.Wallet.address,
            addedAt: uw.Wallet.addedAt
          }
        })),
        pagination: {
          total: result.total,
          page,
          limit,
          totalPages: Math.ceil(result.total / limit),
          hasNext: page < Math.ceil(result.total / limit),
          hasPrevious: page > 1
        }
      };
    } catch (error) {
      logDeduplicator.error('Error retrieving wallets:', { 
        error, 
        userId 
      });
      throw error;
    }
  }

  /**
   * Supprime un wallet d'un utilisateur
   * @param walletId ID du wallet à supprimer
   * @param userId ID de l'utilisateur
   * @throws Erreur si le wallet n'est pas trouvé
   */
  public async removeWalletFromUser(walletId: number, userId: number): Promise<void> {
    try {
      // Utiliser le service de transaction pour la suppression
      await transactionService.execute(async (tx) => {
        // Configurer les repositories pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx);
        userWalletRepository.setPrismaClient(tx);
        
        // Vérifier si l'association existe
        const userWallet = await userWalletRepository.findByUserAndWallet(userId, walletId);
        if (!userWallet) {
          throw new WalletNotFoundError();
        }

        // Supprimer l'association
        await userWalletRepository.delete(userWallet.id);
      });

      // Réinitialiser les clients Prisma
      this.repository.resetPrismaClient();
      userWalletRepository.resetPrismaClient();

      // Invalider le cache
      await this.invalidateEntityListCache();

      logDeduplicator.info('Wallet removed from user successfully', { walletId, userId });
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw error;
      }
      logDeduplicator.error('Error removing wallet from user:', { error, walletId, userId });
      throw error;
    }
  }

  /**
   * Met à jour le nom d'un wallet pour un utilisateur spécifique
   * @param userId ID de l'utilisateur
   * @param walletId ID du wallet
   * @param name Nouveau nom du wallet
   * @returns Le UserWallet mis à jour
   */
  public async updateWalletName(userId: number, walletId: number, name: string) {
    try {
      // Valider le nom
      const validationResult = walletUpdateSchema.shape.name.safeParse(name);
      if (!validationResult.success) {
        throw new WalletValidationError('Invalid wallet name');
      }

      // Utiliser le service de transaction pour la mise à jour
      const updatedUserWallet = await transactionService.execute(async (tx) => {
        // Configurer les repositories pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx);
        userWalletRepository.setPrismaClient(tx);
        
        // Vérifier si l'association existe
        const userWallet = await userWalletRepository.findByUserAndWallet(userId, walletId);
        if (!userWallet) {
          throw new WalletNotFoundError();
        }

        // Mettre à jour le nom
        return await userWalletRepository.updateName(userWallet.id, name);
      });

      // Réinitialiser les clients Prisma
      this.repository.resetPrismaClient();
      userWalletRepository.resetPrismaClient();

      // Invalider le cache
      await this.invalidateEntityListCache();

      logDeduplicator.info('Wallet name updated successfully', { 
        userId, 
        walletId, 
        name 
      });

      return updatedUserWallet;
    } catch (error) {
      if (error instanceof WalletNotFoundError || 
          error instanceof WalletValidationError) {
        throw error;
      }
      logDeduplicator.error('Error updating wallet name:', { 
        error, 
        userId, 
        walletId, 
        name 
      });
      throw error;
    }
  }

  /**
   * Ajoute plusieurs wallets en une seule transaction (bulk import)
   * @param privyUserId ID Privy de l'utilisateur
   * @param wallets Array de wallets à ajouter
   * @param walletListId ID optionnel de la liste à laquelle ajouter les wallets
   * @returns Statistiques du bulk import
   */
  public async bulkAddWallets(
    privyUserId: string, 
    wallets: Array<{ address: string; name?: string }>,
    walletListId?: number
  ) {
    try {
      logDeduplicator.info('Starting bulk wallet import', { 
        privyUserId, 
        walletsCount: wallets.length,
        walletListId 
      });

      // Pré-validation des adresses avant la transaction
      const errors: Array<{ address: string; reason: string }> = [];
      const validWallets: Array<{ address: string; name?: string }> = [];

      for (const wallet of wallets) {
        if (!this.validateEthereumAddress(wallet.address)) {
          errors.push({
            address: wallet.address,
            reason: 'Invalid address format'
          });
        } else {
          validWallets.push(wallet);
        }
      }

      if (validWallets.length === 0) {
        logDeduplicator.warn('No valid wallets to import', { 
          privyUserId, 
          totalErrors: errors.length 
        });
        return {
          total: wallets.length,
          added: 0,
          skipped: wallets.length,
          errors
        };
      }

      // Utiliser le service de transaction pour l'import bulk
      const result = await transactionService.execute(async (tx) => {
        // Configurer les repositories pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx);
        userWalletRepository.setPrismaClient(tx);

        // Vérifier que l'utilisateur existe
        const user = await tx.user.findUnique({
          where: { privyUserId }
        });

        if (!user) {
          throw new UserNotFoundError();
        }

        // Vérifier si walletListId est fourni et que l'utilisateur y a accès
        if (walletListId) {
          const walletList = await tx.walletList.findUnique({
            where: { id: walletListId }
          });

          if (!walletList) {
            const error = new WalletValidationError('Wallet list not found');
            (error as any).statusCode = 404;
            throw error;
          }

          if (walletList.userId !== user.id) {
            const error = new WalletValidationError('Access denied to this wallet list');
            (error as any).statusCode = 403;
            throw error;
          }
        }

        // Étape 1: Bulk insert des wallets (skip duplicates)
        const addresses = validWallets.map((w: any) => w.address);
        await this.repository.bulkCreate(addresses);

        // Étape 2: Récupérer tous les wallet IDs
        const walletRecords = await this.repository.findManyByAddresses(addresses);
        const addressToWalletId = new Map(
          walletRecords.map((w: any) => [w.address, w.id])
        );

        // Étape 3: Vérifier quels wallets l'utilisateur possède déjà
        const existingUserWallets = await userWalletRepository.findManyByUserAndWallets(
          user.id,
          walletRecords.map((w: any) => w.id)
        );
        const existingWalletIds = new Set(existingUserWallets.map((uw: any) => uw.walletId));

        // Étape 4: Préparer les données UserWallet (seulement les nouveaux)
        const userWalletData: Array<{ userId: number; walletId: number; name?: string }> = [];
        const walletMap = new Map(validWallets.map((w: any) => [w.address, w.name]));

        for (const walletRecord of walletRecords) {
          if (!existingWalletIds.has(walletRecord.id)) {
            userWalletData.push({
              userId: user.id,
              walletId: walletRecord.id,
              name: walletMap.get(walletRecord.address)
            });
          }
        }

        // Étape 5: Bulk insert UserWallet
        if (userWalletData.length > 0) {
          await userWalletRepository.bulkCreate(userWalletData);
        }

        // Étape 6: Si walletListId fourni, ajouter à la liste
        let addedToList = 0;
        if (walletListId) {
          // Récupérer les UserWallets créés/existants
          const allUserWallets = await userWalletRepository.findManyByUserAndWallets(
            user.id,
            walletRecords.map((w: any) => w.id)
          );

          // Vérifier quels sont déjà dans la liste
          const existingListItems = await tx.walletListItem.findMany({
            where: {
              walletListId,
              userWalletId: {
                in: allUserWallets.map((uw: any) => uw.id)
              }
            }
          });
          const existingListItemIds = new Set(existingListItems.map((li: any) => li.userWalletId));

          // Préparer les données WalletListItem (seulement les nouveaux)
          const walletListItemData = allUserWallets
            .filter((uw: any) => !existingListItemIds.has(uw.id))
            .map((uw: any, index: number) => ({
              walletListId,
              userWalletId: uw.id,
              order: index
            }));

          if (walletListItemData.length > 0) {
            await tx.walletListItem.createMany({
              data: walletListItemData,
              skipDuplicates: true
            });
            addedToList = walletListItemData.length;
          }
        }

        const added = userWalletData.length;
        const skipped = validWallets.length - added + errors.length;

        return {
          total: wallets.length,
          added,
          skipped,
          errors,
          addedToList
        };
      });

      // Réinitialiser les clients Prisma
      this.repository.resetPrismaClient();
      userWalletRepository.resetPrismaClient();

      // Invalider le cache
      await this.invalidateEntityListCache();

      logDeduplicator.info('Bulk wallet import completed', { 
        privyUserId,
        total: result.total,
        added: result.added,
        skipped: result.skipped,
        errorsCount: result.errors.length,
        addedToList: result.addedToList
      });

      return result;
    } catch (error) {
      if (error instanceof UserNotFoundError ||
          error instanceof WalletValidationError) {
        throw error;
      }
      logDeduplicator.error('Error in bulk wallet import:', { 
        error, 
        privyUserId,
        walletsCount: wallets.length,
        walletListId
      });
      throw error;
    }
  }

  /**
   * Supprime plusieurs wallets en une seule opération (bulk delete)
   * @param privyUserId ID Privy de l'utilisateur
   * @param walletIds Array de wallet IDs à supprimer
   * @returns Statistiques du bulk delete
   */
  public async bulkDeleteWallets(privyUserId: string, walletIds: number[]) {
    try {
      logDeduplicator.info('Starting bulk wallet delete', { 
        privyUserId, 
        walletsCount: walletIds.length 
      });

      // Utiliser le service de transaction pour le bulk delete
      const result = await transactionService.execute(async (tx) => {
        // Configurer les repositories pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx);
        userWalletRepository.setPrismaClient(tx);

        // Vérifier que l'utilisateur existe
        const user = await tx.user.findUnique({
          where: { privyUserId }
        });

        if (!user) {
          throw new UserNotFoundError();
        }

        // Vérifier quels wallets existent pour cet utilisateur
        const existingUserWallets = await userWalletRepository.findManyByUserAndWallets(
          user.id,
          walletIds
        );

        const existingWalletIds = new Set(existingUserWallets.map((uw: any) => uw.walletId));
        
        // Identifier les wallets qui n'existent pas
        const errors: Array<{ walletId: number; reason: string }> = [];
        walletIds.forEach(walletId => {
          if (!existingWalletIds.has(walletId)) {
            errors.push({
              walletId,
              reason: 'Wallet not found or not owned by user'
            });
          }
        });

        // Supprimer les associations existantes
        const validWalletIds = walletIds.filter(id => existingWalletIds.has(id));
        let deleted = 0;

        if (validWalletIds.length > 0) {
          const deleteResult = await userWalletRepository.bulkDeleteByUserAndWallets(
            user.id,
            validWalletIds
          );
          deleted = deleteResult.count;
        }

        return {
          total: walletIds.length,
          deleted,
          failed: errors.length,
          errors
        };
      });

      // Réinitialiser les clients Prisma
      this.repository.resetPrismaClient();
      userWalletRepository.resetPrismaClient();

      // Invalider le cache
      await this.invalidateEntityListCache();

      logDeduplicator.info('Bulk wallet delete completed', { 
        privyUserId,
        total: result.total,
        deleted: result.deleted,
        failed: result.failed
      });

      return result;
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        throw error;
      }
      logDeduplicator.error('Error in bulk wallet delete:', { 
        error, 
        privyUserId,
        walletsCount: walletIds.length
      });
      throw error;
    }
  }
}