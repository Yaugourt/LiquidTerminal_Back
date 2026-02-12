import crypto from 'crypto';
import { prisma } from '../../core/prisma.service';
import { redisService } from '../../core/redis.service';
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
  TelegramError,
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

  // ==================== DEEP LINK CODE SYSTEM ====================

  private static readonly LINK_CODE_PREFIX = 'telegram:link:';
  private static readonly LINK_CODE_TTL = 300; // 5 minutes
  private static readonly LINK_CODE_LENGTH = 8;

  /**
   * Generate a temporary link code for a user.
   * Called by frontend: POST /auth/telegram/generate-link
   * Returns a code the user sends to the bot via deep link.
   */
  public async generateLinkCode(userId: number): Promise<{ code: string; deepLink: string }> {
    try {
      // Check if user already has a linked telegram
      const existingLink = await prisma.telegramUser.findFirst({
        where: { linkedUserId: userId },
      });

      if (existingLink) {
        throw new TelegramAlreadyLinkedError('Your account is already linked to a Telegram account');
      }

      // Generate a random code
      const code = crypto.randomBytes(TelegramService.LINK_CODE_LENGTH).toString('hex').slice(0, TelegramService.LINK_CODE_LENGTH).toUpperCase();

      // Store in Redis: code -> userId (TTL 5 min)
      const redisKey = `${TelegramService.LINK_CODE_PREFIX}${code}`;
      await redisService.set(redisKey, JSON.stringify({ userId }), TelegramService.LINK_CODE_TTL);

      const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'LiquidTerminalBot';
      const deepLink = `https://t.me/${botUsername}?start=LINK_${code}`;

      logDeduplicator.info('TelegramService: Link code generated', {
        userId,
        code,
      });

      return { code, deepLink };
    } catch (error) {
      if (error instanceof TelegramError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error generating link code', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Verify a link code and link the Telegram account.
   * Called by bot: POST /telegram/verify-link
   * The bot extracts the code from /start LINK_XXXXX and sends it here with the telegramId.
   */
  public async verifyLinkCode(
    code: string,
    telegramId: bigint,
    username?: string,
    firstName?: string
  ): Promise<{ userId: number }> {
    try {
      // Get the code from Redis
      const redisKey = `${TelegramService.LINK_CODE_PREFIX}${code}`;
      const stored = await redisService.get(redisKey);

      if (!stored) {
        throw new TelegramError('Invalid or expired link code', 400, 'INVALID_LINK_CODE');
      }

      const { userId } = JSON.parse(stored) as { userId: number };

      // Check if this telegramId is already linked to another user
      const existing = await prisma.telegramUser.findUnique({
        where: { telegramId },
      });

      if (existing && existing.linkedUserId && existing.linkedUserId !== userId) {
        throw new TelegramAlreadyLinkedError();
      }

      // Link the account
      if (existing) {
        await prisma.telegramUser.update({
          where: { telegramId },
          data: {
            linkedUserId: userId,
            username: username || existing.username,
            firstName: firstName || existing.firstName,
          },
        });
      } else {
        await prisma.telegramUser.create({
          data: {
            telegramId,
            linkedUserId: userId,
            username,
            firstName,
          },
        });
      }

      // Delete the code from Redis (one-time use)
      await redisService.delete(redisKey);

      logDeduplicator.info('TelegramService: Account linked via deep link', {
        telegramId: telegramId.toString(),
        userId,
        code,
      });

      return { userId };
    } catch (error) {
      if (error instanceof TelegramError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error verifying link code', {
        code,
        telegramId: telegramId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check if a link code has been consumed (account linked).
   * Called by frontend to poll: GET /auth/telegram/link-status/:code
   */
  public async getLinkStatus(code: string, userId: number): Promise<{ linked: boolean; telegramUsername?: string }> {
    try {
      // Check if user now has a linked telegram
      const telegramUser = await prisma.telegramUser.findFirst({
        where: { linkedUserId: userId },
      });

      if (telegramUser) {
        return {
          linked: true,
          telegramUsername: telegramUser.username || undefined,
        };
      }

      // Check if the code is still valid (pending)
      const redisKey = `${TelegramService.LINK_CODE_PREFIX}${code}`;
      const stored = await redisService.get(redisKey);

      return {
        linked: false,
        // Code still pending = user hasn't clicked the bot link yet
      };
    } catch (error) {
      logDeduplicator.error('TelegramService: Error checking link status', {
        code,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Unlink a Telegram account from a LiquidTerminal user.
   * Called by frontend: DELETE /auth/telegram/unlink
   */
  public async unlinkAccount(userId: number): Promise<void> {
    try {
      const telegramUser = await prisma.telegramUser.findFirst({
        where: { linkedUserId: userId },
      });

      if (!telegramUser) {
        throw new TelegramAccountNotLinkedError();
      }

      await prisma.telegramUser.update({
        where: { id: telegramUser.id },
        data: { linkedUserId: null },
      });

      logDeduplicator.info('TelegramService: Account unlinked', {
        userId,
        telegramId: telegramUser.telegramId.toString(),
      });
    } catch (error) {
      if (error instanceof TelegramError) {
        throw error;
      }
      logDeduplicator.error('TelegramService: Error unlinking account', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
