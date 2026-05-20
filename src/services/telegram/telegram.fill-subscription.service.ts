import { prismaTelegram } from '../../core/prisma.telegram.service';

/**
 * Shape of an active fill subscription returned by getActiveSubscriptions().
 */
export interface ActiveFillSubscription {
  id: string;
  telegramUserId: string;
  telegramId: string; // BigInt as string for WS routing
  name: string;
  filterCoins: string[];
  filterWallets: string[];
  minUsd: number;
  /// 'BUY' | 'SELL' | null (both)
  filterSide: 'BUY' | 'SELL' | null;
  /// 'PERP' | 'SPOT' | null (both)
  filterSource: 'PERP' | 'SPOT' | null;
  /// 'OPEN' | 'CLOSE' | null (both) — perp only
  filterDirection: 'OPEN' | 'CLOSE' | null;
  /// null = no upper bound
  maxUsd: number | null;
}

/**
 * Service for reading Telegram fill tracking subscriptions.
 * The fill dispatcher consumes these subscriptions to route executed-order alerts.
 */
export class TelegramFillSubscriptionService {
  private static instance: TelegramFillSubscriptionService;

  private constructor() {}

  public static getInstance(): TelegramFillSubscriptionService {
    if (!TelegramFillSubscriptionService.instance) {
      TelegramFillSubscriptionService.instance = new TelegramFillSubscriptionService();
    }
    return TelegramFillSubscriptionService.instance;
  }

  /**
   * Get all active fill subscriptions (used by the fill dispatcher).
   */
  public async getActiveSubscriptions(): Promise<ActiveFillSubscription[]> {
    const subscriptions = await prismaTelegram.telegramFillSubscription.findMany({
      where: { isActive: true },
      include: {
        telegramUser: {
          select: { telegramId: true },
        },
      },
    });

    return subscriptions.map((sub) => ({
      id: sub.id,
      telegramUserId: sub.telegramUserId,
      telegramId: sub.telegramUser.telegramId.toString(),
      name: sub.name,
      filterCoins: sub.filterCoins,
      filterWallets: sub.filterWallets,
      minUsd: Number(sub.minUsd),
      filterSide: normalizeSide(sub.filterSide),
      filterSource: normalizeSource(sub.filterSource),
      filterDirection: normalizeDirection(sub.filterDirection),
      maxUsd: sub.maxUsd != null ? Number(sub.maxUsd) : null,
    }));
  }
}

function normalizeSide(value: string | null): 'BUY' | 'SELL' | null {
  if (value === 'BUY' || value === 'SELL') return value;
  return null;
}

function normalizeSource(value: string | null): 'PERP' | 'SPOT' | null {
  if (value === 'PERP' || value === 'SPOT') return value;
  return null;
}

function normalizeDirection(value: string | null): 'OPEN' | 'CLOSE' | null {
  if (value === 'OPEN' || value === 'CLOSE') return value;
  return null;
}
