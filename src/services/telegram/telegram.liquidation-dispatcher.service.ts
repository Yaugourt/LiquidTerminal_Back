import { prismaTelegram } from '../../core/prisma.telegram.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { LiquidationsWebSocketService } from '../liquidations/liquidations.ws.service';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import { AggregatedLiquidation } from '../../types/liquidations.types';
import { formatLiquidationAlert } from '../../utils/telegram.formatting';
import { TelegramAccountNotLinkedError, TelegramUserNotFoundError } from '../../errors/telegram.errors';
import { TelegramService } from './telegram.service';

/**
 * Shape of an active liquidation subscription
 */
interface ActiveLiquidationSubscription {
  id: string;
  telegramUserId: string;
  telegramId: string; // BigInt as string for WS routing
  subscriptionType: string; // 'all' | 'filtered'
  filterCoins: string[];
  filterMinUsd: number;
  filterWallets: string[];
  useLinkedWallets: boolean;
}

/**
 * TelegramLiquidationDispatcherService
 *
 * Bridges LiquidationsWebSocketService events to the Telegram bot via /ws.
 *
 * Flow:
 * 1. Subscribes to LiquidationsWebSocketService.onProcessedLiquidation()
 * 2. On each liquidation, checks active subscriptions (cached 30s in memory)
 * 3. Filters by subscriptionType, filterCoins, filterMinUsd, filterWallets, useLinkedWallets
 * 4. Deduplicates via TelegramSentAlert unique constraint (telegramUserId, liquidationId)
 * 5. Pushes matching alerts to InternalWebSocketServer.broadcastLiquidationAlert()
 *    → Bot receives { type: 'liquidation_alert', data: { telegramId, message } }
 *    → Bot routes by telegramId and calls bot.api.sendMessage()
 */
export class TelegramLiquidationDispatcherService {
  private static instance: TelegramLiquidationDispatcherService;

  private unsubscribeCallback: (() => void) | null = null;

  private subscriptionCache: ActiveLiquidationSubscription[] = [];
  private cacheLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  // Cache linked wallets per user (TTL 60s) to avoid DB round-trips per liquidation
  private linkedWalletsCache = new Map<string, { wallets: string[]; fetchedAt: number }>();
  private static readonly LINKED_WALLETS_CACHE_TTL_MS = 60_000;

  private constructor() {}

  public static getInstance(): TelegramLiquidationDispatcherService {
    if (!TelegramLiquidationDispatcherService.instance) {
      TelegramLiquidationDispatcherService.instance = new TelegramLiquidationDispatcherService();
    }
    return TelegramLiquidationDispatcherService.instance;
  }

  /**
   * Start the dispatcher — subscribe to processed liquidations
   */
  public start(): void {
    const wsService = LiquidationsWebSocketService.getInstance();

    this.unsubscribeCallback = wsService.onProcessedLiquidation(async (liquidations) => {
      for (const liq of liquidations) {
        await this.dispatch(liq);
      }
    });

    logDeduplicator.info('TelegramLiquidationDispatcherService: Started');
  }

  /**
   * Stop the dispatcher
   */
  public stop(): void {
    if (this.unsubscribeCallback) {
      this.unsubscribeCallback();
      this.unsubscribeCallback = null;
    }
    this.subscriptionCache = [];
    this.cacheLoadedAt = 0;
    this.linkedWalletsCache.clear();

    logDeduplicator.info('TelegramLiquidationDispatcherService: Stopped');
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Reload subscription cache if stale (every 30s)
   */
  private async ensureCacheFresh(): Promise<void> {
    if (Date.now() - this.cacheLoadedAt < TelegramLiquidationDispatcherService.CACHE_TTL_MS) return;

    try {
      const subs = await prismaTelegram.telegramSubscription.findMany({
        where: { isActive: true },
        include: { telegramUser: { select: { telegramId: true } } },
      });

      this.subscriptionCache = subs.map((sub) => ({
        id: sub.id,
        telegramUserId: sub.telegramUserId,
        telegramId: sub.telegramUser.telegramId.toString(),
        subscriptionType: sub.subscriptionType,
        filterCoins: sub.filterCoins,
        filterMinUsd: Number(sub.filterMinUsd),
        filterWallets: sub.filterWallets,
        useLinkedWallets: sub.useLinkedWallets,
      }));

      this.cacheLoadedAt = Date.now();

      logDeduplicator.debug('TelegramLiquidationDispatcherService: Subscription cache refreshed', {
        count: this.subscriptionCache.length,
      });
    } catch (error) {
      logDeduplicator.error('TelegramLiquidationDispatcherService: Failed to refresh subscription cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Dispatch a single processed liquidation to all matching subscriptions
   */
  private async dispatch(liq: AggregatedLiquidation): Promise<void> {
    await this.ensureCacheFresh();

    if (this.subscriptionCache.length === 0) return;

    // Use hash as deduplication ID (same as bot alertDispatcher)
    const liquidationId = liq.hash;

    for (const sub of this.subscriptionCache) {
      // Check if liquidation matches subscription filters
      const matches = await this.matchesFilters(liq, sub);
      if (!matches) continue;

      // Deduplicate — atomic insert, catch P2002 if already sent
      const alreadySent = await this.markSent(sub.telegramUserId, liquidationId);
      if (alreadySent) continue;

      // Format message and broadcast via /ws
      try {
        const message = formatLiquidationAlert(liq);
        InternalWebSocketServer.getInstance().broadcastLiquidationAlert(sub.telegramId, message);

        logDeduplicator.info('TelegramLiquidationDispatcherService: Alert dispatched', {
          telegramId: sub.telegramId,
          liquidationId,
          coin: liq.coin,
          notionalUsd: liq.notional_total,
        });
      } catch (error) {
        logDeduplicator.error('TelegramLiquidationDispatcherService: Failed to broadcast alert', {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: sub.id,
          liquidationId,
        });
      }
    }
  }

  /**
   * Check if a liquidation matches a subscription's filters
   */
  private async matchesFilters(
    liq: AggregatedLiquidation,
    sub: ActiveLiquidationSubscription
  ): Promise<boolean> {
    // 'all' type — no filtering
    if (sub.subscriptionType === 'all') return true;

    // Filter by coin
    if (sub.filterCoins.length > 0) {
      if (!sub.filterCoins.includes(liq.coin.toUpperCase())) return false;
    }

    // Filter by minimum USD
    if (sub.filterMinUsd > 0) {
      if (liq.notional_total < sub.filterMinUsd) return false;
    }

    // Filter by linked wallets (fetched from LiquidTerminal DB, cached 60s)
    if (sub.useLinkedWallets) {
      const linkedWallets = await this.getLinkedWallets(sub.telegramId, sub.telegramUserId);
      if (linkedWallets.length === 0) return false;
      if (!linkedWallets.includes(liq.liquidated_user.toLowerCase())) return false;
      return true;
    }

    // Filter by manual wallets
    if (sub.filterWallets.length > 0) {
      if (!sub.filterWallets.includes(liq.liquidated_user.toLowerCase())) return false;
    }

    return true;
  }

  /**
   * Get linked wallet addresses for a Telegram user (cached 60s)
   */
  private async getLinkedWallets(telegramId: string, telegramUserId: string): Promise<string[]> {
    const cached = this.linkedWalletsCache.get(telegramUserId);
    if (cached && Date.now() - cached.fetchedAt < TelegramLiquidationDispatcherService.LINKED_WALLETS_CACHE_TTL_MS) {
      return cached.wallets;
    }

    try {
      const result = await TelegramService.getInstance().getLinkedWallets(BigInt(telegramId));
      const wallets = result.data.map((w) => w.address.toLowerCase());

      this.linkedWalletsCache.set(telegramUserId, { wallets, fetchedAt: Date.now() });
      return wallets;
    } catch (error) {
      if (error instanceof TelegramUserNotFoundError || error instanceof TelegramAccountNotLinkedError) {
        // No linked account — cache empty result to avoid hammering DB
        this.linkedWalletsCache.set(telegramUserId, { wallets: [], fetchedAt: Date.now() });
        return [];
      }
      logDeduplicator.warn('TelegramLiquidationDispatcherService: Failed to fetch linked wallets', {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return stale cache if available
      return cached?.wallets ?? [];
    }
  }

  /**
   * Mark a liquidation as sent for a subscription.
   * Uses unique constraint (telegramUserId, liquidationId) — insert succeeds = not sent yet.
   * Returns true if already sent (duplicate), false if newly inserted.
   */
  private async markSent(telegramUserId: string, liquidationId: string): Promise<boolean> {
    try {
      await prismaTelegram.telegramSentAlert.create({
        data: { telegramUserId, liquidationId },
      });
      return false; // Successfully inserted — not a duplicate
    } catch {
      return true; // P2002 unique constraint violation — already sent
    }
  }
}
