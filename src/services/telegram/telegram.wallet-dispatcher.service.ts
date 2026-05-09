import { prismaTelegram } from '../../core/prisma.telegram.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HypeDexerCompletedTradesWSClient } from '../../clients/hypedexer/websocket/completed-trades.ws.client';
import { TelegramWalletSubscriptionService } from './telegram.wallet-subscription.service';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import { CompletedTrade } from '../../types/wallet-events.types';

/**
 * Shape of an active subscription returned by getActiveSubscriptions()
 */
interface ActiveSubscription {
  id: string;
  telegramId: string;
  name: string;
  walletAddresses: string[];
  eventTypes: string[];
  minAmountUsd: number;
}

/**
 * TelegramWalletDispatcherService
 *
 * Bridges HypeDexer completed_trades events to the Telegram bot via /ws.
 *
 * Flow:
 * 1. Subscribes to HypeDexerCompletedTradesWSClient (1 global sub)
 * 2. On each trade, checks active wallet subscriptions (cached 30s)
 * 3. Filters by walletAddress, eventType, minAmountUsd
 * 4. Deduplicates via TelegramWalletSentAlert unique constraint
 * 5. Pushes matching events to InternalWebSocketServer.broadcastWalletEvent()
 *    → Bot receives { type: 'wallet_event', data: { telegramId, trade, subscriptionName } }
 *    → Bot routes by telegramId and sends the Telegram message
 */
export class TelegramWalletDispatcherService {
  private static instance: TelegramWalletDispatcherService;

  private wsClient: HypeDexerCompletedTradesWSClient | null = null;
  private unsubscribeCallback: (() => void) | null = null;

  private subscriptionCache: ActiveSubscription[] = [];
  private cacheLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  private constructor() {}

  public static getInstance(): TelegramWalletDispatcherService {
    if (!TelegramWalletDispatcherService.instance) {
      TelegramWalletDispatcherService.instance = new TelegramWalletDispatcherService();
    }
    return TelegramWalletDispatcherService.instance;
  }

  /**
   * Start the dispatcher — connect to HypeDexer and begin dispatching
   */
  public start(): void {
    this.wsClient = HypeDexerCompletedTradesWSClient.getInstance();
    this.wsClient.start();

    this.unsubscribeCallback = this.wsClient.onCompletedTrade(async (trades) => {
      for (const trade of trades) {
        await this.dispatch(trade);
      }
    });

    logDeduplicator.info('TelegramWalletDispatcherService: Started');
  }

  /**
   * Stop the dispatcher — disconnect WS and clear cache
   */
  public stop(): void {
    if (this.unsubscribeCallback) {
      this.unsubscribeCallback();
      this.unsubscribeCallback = null;
    }
    if (this.wsClient) {
      this.wsClient.stop();
      this.wsClient = null;
    }
    this.subscriptionCache = [];
    this.cacheLoadedAt = 0;

    logDeduplicator.info('TelegramWalletDispatcherService: Stopped');
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Reload subscription cache if stale (every 30s)
   */
  private async ensureCacheFresh(): Promise<void> {
    if (Date.now() - this.cacheLoadedAt < TelegramWalletDispatcherService.CACHE_TTL_MS) return;

    try {
      this.subscriptionCache = await TelegramWalletSubscriptionService.getInstance().getActiveSubscriptions();
      this.cacheLoadedAt = Date.now();

      logDeduplicator.info('TelegramWalletDispatcherService: Subscription cache refreshed', {
        count: this.subscriptionCache.length,
      });
    } catch (error) {
      logDeduplicator.error('TelegramWalletDispatcherService: Failed to refresh subscription cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Dispatch a single completed trade to all matching subscriptions
   */
  private async dispatch(trade: CompletedTrade): Promise<void> {
    await this.ensureCacheFresh();

    if (this.subscriptionCache.length === 0) return;

    for (const sub of this.subscriptionCache) {
      // Filter by wallet address (case-insensitive, user is already lowercase)
      const matchesWallet = sub.walletAddresses.some(
        (addr) => addr.toLowerCase() === trade.user
      );
      if (!matchesWallet) continue;

      // Filter by event type — if eventTypes is empty, all types pass
      if (sub.eventTypes.length > 0 && !sub.eventTypes.includes('TRADE')) continue;

      // Filter by minimum amount
      if (trade.positionValue < sub.minAmountUsd) continue;

      // Deduplication — insert attempt, catch unique constraint violation
      const alreadySent = await this.markSent(sub.id, trade.tradeId);
      if (alreadySent) continue;

      // Push to bot via internal WebSocket
      try {
        InternalWebSocketServer.getInstance().broadcastWalletEvent(sub.telegramId, trade, sub.name);

        logDeduplicator.info('TelegramWalletDispatcherService: Alert dispatched', {
          telegramId: sub.telegramId,
          subscriptionName: sub.name,
          tradeId: trade.tradeId,
          coin: trade.coin,
          pnlRealized: trade.pnlRealized,
        });
      } catch (error) {
        logDeduplicator.error('TelegramWalletDispatcherService: Failed to broadcast wallet event', {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: sub.id,
          tradeId: trade.tradeId,
        });
      }
    }
  }

  /**
   * Mark a trade as sent for a subscription.
   * Uses unique constraint (subscriptionId, eventId) — insert succeeds = not sent yet.
   * Returns true if already sent (duplicate), false if newly inserted.
   */
  private async markSent(subscriptionId: string, eventId: string): Promise<boolean> {
    try {
      await prismaTelegram.telegramWalletSentAlert.create({
        data: { subscriptionId, eventId },
      });
      return false; // Successfully inserted — not a duplicate
    } catch {
      return true; // P2002 unique constraint violation — already sent
    }
  }
}
