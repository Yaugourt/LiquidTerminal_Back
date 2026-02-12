import { prisma } from '../../core/prisma.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { WalletService } from '../wallet/wallet.service';
import { WalletListService } from '../walletlist/walletlist.service';
import { WalletListItemService } from '../walletlist/walletlist-item.service';
import {
  LinkedAccountResponse,
  LinkedWalletResponse,
  LinkedWalletListResponse,
} from '../../types/telegram.types';
import {
  TelegramUserNotFoundError,
  TelegramAccountNotLinkedError,
  TelegramAlreadyLinkedError,
} from '../../errors/telegram.errors';

/**
 * TelegramService (Singleton)
 * 
 * Bridge between the Telegram bot and existing services.
 * Resolves telegramId -> userId, then delegates to WalletService / WalletListService.
 */
export class TelegramService {
  private static instance: TelegramService;

  private walletService = new WalletService();
  private walletListService = new WalletListService();
  private walletListItemService = new WalletListItemService();

  private constructor() {}

  public static getInstance(): TelegramService {
    if (!TelegramService.instance) {
      TelegramService.instance = new TelegramService();
    }
    return TelegramService.instance;
  }

  // ==================== PRIVATE HELPERS ====================

  /**
   * Resolve telegramId -> userId
   * @throws TelegramAccountNotLinkedError if no linked account
   */
  private async resolveUserId(telegramId: bigint): Promise<number> {
    const telegramUser = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: { linkedUserId: true },
    });

    if (!telegramUser) {
      throw new TelegramUserNotFoundError();
    }

    if (!telegramUser.linkedUserId) {
      throw new TelegramAccountNotLinkedError();
    }

    return telegramUser.linkedUserId;
  }

  // ==================== BOT ENDPOINTS ====================

  /**
   * Get linked account info for a Telegram user.
   * Called by bot on /start to check if account is linked.
   */
  public async getLinkedAccount(telegramId: bigint): Promise<LinkedAccountResponse> {
    try {
      const telegramUser = await prisma.telegramUser.findUnique({
        where: { telegramId },
        include: {
          linkedUser: {
            include: {
              _count: {
                select: { UserWallets: true },
              },
            },
          },
        },
      });

      if (!telegramUser || !telegramUser.linkedUser) {
        return {
          linked: false,
          walletCount: 0,
        };
      }

      const user = telegramUser.linkedUser;

      return {
        linked: true,
        userId: user.id,
        email: user.email || undefined,
        name: user.name || undefined,
        walletCount: user._count.UserWallets,
      };
    } catch (error) {
      logDeduplicator.error('TelegramService: Error getting linked account', {
        telegramId: telegramId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get linked wallets for a Telegram user.
   * Delegates to WalletService.getWalletsByUser().
   */
  public async getLinkedWallets(
    telegramId: bigint,
    page: number = 1,
    limit: number = 50
  ): Promise<{ data: LinkedWalletResponse[]; pagination: any }> {
    try {
      const userId = await this.resolveUserId(telegramId);
      const result = await this.walletService.getWalletsByUser(userId, page, limit);

      return {
        data: result.data.map((uw) => ({
          id: uw.id,
          address: uw.wallet.address,
          name: uw.name,
          addedAt: uw.addedAt,
        })),
        pagination: result.pagination,
      };
    } catch (error) {
      if (error instanceof TelegramUserNotFoundError || error instanceof TelegramAccountNotLinkedError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error getting linked wallets', {
        telegramId: telegramId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get linked wallet lists for a Telegram user.
   * Delegates to WalletListService.getByUser().
   */
  public async getLinkedWalletLists(telegramId: bigint): Promise<LinkedWalletListResponse[]> {
    try {
      const userId = await this.resolveUserId(telegramId);
      const walletLists = await this.walletListService.getByUser(userId);

      return walletLists.map((wl) => ({
        id: wl.id,
        name: wl.name,
        description: wl.description,
        isPublic: wl.isPublic,
        itemsCount: wl.itemsCount,
        createdAt: wl.createdAt,
      }));
    } catch (error) {
      if (error instanceof TelegramUserNotFoundError || error instanceof TelegramAccountNotLinkedError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error getting linked wallet lists', {
        telegramId: telegramId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get wallet list items for a Telegram user.
   * Delegates to WalletListItemService.getByWalletListWithPermission().
   */
  public async getWalletListItems(telegramId: bigint, listId: number) {
    try {
      const userId = await this.resolveUserId(telegramId);
      return await this.walletListItemService.getByWalletListWithPermission(listId, userId);
    } catch (error) {
      if (error instanceof TelegramUserNotFoundError || error instanceof TelegramAccountNotLinkedError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error getting wallet list items', {
        telegramId: telegramId.toString(),
        listId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ==================== ACCOUNT LINKING ====================

  /**
   * Link a Telegram account to a LiquidTerminal user.
   * Called when user links via Privy on the frontend (POST /auth/link-telegram).
   */
  public async linkAccount(
    telegramId: bigint,
    userId: number,
    username?: string,
    firstName?: string
  ): Promise<void> {
    try {
      // Check if this telegramId is already linked to another user
      const existing = await prisma.telegramUser.findUnique({
        where: { telegramId },
      });

      if (existing && existing.linkedUserId && existing.linkedUserId !== userId) {
        throw new TelegramAlreadyLinkedError();
      }

      if (existing) {
        // Update existing telegram user
        await prisma.telegramUser.update({
          where: { telegramId },
          data: {
            linkedUserId: userId,
            username: username || existing.username,
            firstName: firstName || existing.firstName,
          },
        });
      } else {
        // Create new telegram user with link
        await prisma.telegramUser.create({
          data: {
            telegramId,
            linkedUserId: userId,
            username,
            firstName,
          },
        });
      }

      logDeduplicator.info('TelegramService: Account linked', {
        telegramId: telegramId.toString(),
        userId,
      });
    } catch (error) {
      if (error instanceof TelegramAlreadyLinkedError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error linking account', {
        telegramId: telegramId.toString(),
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Unlink a Telegram account from a LiquidTerminal user.
   */
  public async unlinkAccount(telegramId: bigint): Promise<void> {
    try {
      const telegramUser = await prisma.telegramUser.findUnique({
        where: { telegramId },
      });

      if (!telegramUser) {
        throw new TelegramUserNotFoundError();
      }

      await prisma.telegramUser.update({
        where: { telegramId },
        data: { linkedUserId: null },
      });

      logDeduplicator.info('TelegramService: Account unlinked', {
        telegramId: telegramId.toString(),
      });
    } catch (error) {
      if (error instanceof TelegramUserNotFoundError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error unlinking account', {
        telegramId: telegramId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
