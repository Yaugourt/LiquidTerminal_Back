import { prismaTelegram } from '../../core/prisma.telegram.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HypeDexerLiveDataWSClient } from '../../clients/hypedexer/websocket/live-data.ws.client';
import { HypeDexerSpotFillsWSClient } from '../../clients/hypedexer/websocket/fills-spot.ws.client';
import { TelegramFillSubscriptionService, ActiveFillSubscription } from './telegram.fill-subscription.service';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import { NormalizedFill, AggregatedFill, SpotFill } from '../../types/fill-alerts.types';
import { formatFillAlert } from '../../utils/telegram.formatting';
import { FillAggregator } from './fill-aggregator';
import {
  markAlertSent,
  RecentEventCache,
  SerialQueue,
  startSentAlertPurge,
} from '../../utils/telegram.alert-dedup';

const CONTEXT = 'TelegramFillAlertDispatcherService';

/**
 * TelegramFillAlertDispatcherService
 *
 * Bridges HypeDexer fill events (perp `allFills` + spot `fills_spot`) to the
 * Telegram bot via /ws as a single unified "fill_alert".
 *
 * Flow:
 * 1. Subscribes to HypeDexerLiveDataWSClient (allFills) and HypeDexerSpotFillsWSClient (fills_spot)
 * 2. Feeds every fill into the FillAggregator, which groups the fills of one
 *    order (`oid`) and emits a single AggregatedFill after a short debounce
 * 3. On each aggregated order, checks active fill subscriptions (cached 30s)
 * 4. Filters by minUsd, filterCoins, filterWallets
 * 5. Deduplicates via TelegramFillSentAlert unique constraint (subscriptionId, eventId)
 * 6. Pushes matching alerts to InternalWebSocketServer.broadcastFillAlert()
 *    → Bot receives { type: 'fill_alert', data: { telegramId, message } }
 *    → Bot routes by telegramId and calls bot.api.sendMessage()
 */
export class TelegramFillAlertDispatcherService {
  private static instance: TelegramFillAlertDispatcherService;

  private liveDataClient: HypeDexerLiveDataWSClient | null = null;
  private spotClient: HypeDexerSpotFillsWSClient | null = null;
  private unsubscribePerp: (() => void) | null = null;
  private unsubscribeSpot: (() => void) | null = null;

  private subscriptionCache: ActiveFillSubscription[] = [];
  private cacheLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  // In-memory dedup: absorbs WS re-flushes/reconnects so the DB is hit once per alert
  private readonly recentAlerts = new RecentEventCache();
  // Serializes dispatch batches (perp + spot) so they never overlap and exhaust the DB pool
  private readonly queue = new SerialQueue(CONTEXT);
  private purgeTimer: NodeJS.Timeout | null = null;

  // Groups the many fills of one order into a single alert (anti-spam).
  private readonly aggregator = new FillAggregator((agg) =>
    this.queue.enqueue(() => this.dispatch(agg))
  );

  private constructor() {}

  public static getInstance(): TelegramFillAlertDispatcherService {
    if (!TelegramFillAlertDispatcherService.instance) {
      TelegramFillAlertDispatcherService.instance = new TelegramFillAlertDispatcherService();
    }
    return TelegramFillAlertDispatcherService.instance;
  }

  /**
   * Start the dispatcher — connect to both HypeDexer fill streams and begin dispatching.
   */
  public start(): void {
    this.liveDataClient = HypeDexerLiveDataWSClient.getInstance();
    this.spotClient = HypeDexerSpotFillsWSClient.getInstance();

    // Both streams feed the aggregator; it emits one AggregatedFill per order,
    // which is then enqueued onto the serial dispatch queue.
    this.unsubscribePerp = this.liveDataClient.onFill((fills) => {
      for (const fill of fills) this.aggregator.add(fill);
    });

    this.unsubscribeSpot = this.spotClient.onSpotFill((fills) => {
      for (const fill of fills) this.aggregator.add(this.spotToNormalized(fill));
    });

    this.purgeTimer = startSentAlertPurge(
      (cutoff) =>
        prismaTelegram.telegramFillSentAlert.deleteMany({ where: { sentAt: { lt: cutoff } } }),
      CONTEXT
    );

    // Idempotent — BaseWebSocketService guards against double-connect.
    this.liveDataClient.start();
    this.spotClient.start();

    logDeduplicator.info('TelegramFillAlertDispatcherService: Started');
  }

  /**
   * Stop the dispatcher — remove callbacks and stop the WS clients.
   */
  public stop(): void {
    if (this.unsubscribePerp) {
      this.unsubscribePerp();
      this.unsubscribePerp = null;
    }
    if (this.unsubscribeSpot) {
      this.unsubscribeSpot();
      this.unsubscribeSpot = null;
    }
    if (this.liveDataClient) {
      this.liveDataClient.stop();
      this.liveDataClient = null;
    }
    if (this.spotClient) {
      this.spotClient.stop();
      this.spotClient = null;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    this.aggregator.clear();
    this.subscriptionCache = [];
    this.cacheLoadedAt = 0;
    this.recentAlerts.clear();

    logDeduplicator.info('TelegramFillAlertDispatcherService: Stopped');
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Map a normalized SpotFill (from the spot WS client) to the unified NormalizedFill.
   */
  private spotToNormalized(fill: SpotFill): NormalizedFill {
    return {
      source: 'spot',
      oid: fill.oid,
      wallet: fill.user.toLowerCase(),
      coin: fill.coin,
      px: fill.px,
      sz: fill.sz,
      notionalUsd: fill.notionalUsd,
      side: fill.side,
      time: fill.time,
      hash: fill.hash,
    };
  }

  /**
   * Reload subscription cache if stale (every 30s).
   */
  private async ensureCacheFresh(): Promise<void> {
    if (Date.now() - this.cacheLoadedAt < TelegramFillAlertDispatcherService.CACHE_TTL_MS) return;

    try {
      this.subscriptionCache = await TelegramFillSubscriptionService.getInstance().getActiveSubscriptions();
      this.cacheLoadedAt = Date.now();

      logDeduplicator.debug('TelegramFillAlertDispatcherService: Subscription cache refreshed', {
        count: this.subscriptionCache.length,
      });
    } catch (error) {
      logDeduplicator.error('TelegramFillAlertDispatcherService: Failed to refresh subscription cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Dispatch a single aggregated order to all matching subscriptions.
   */
  private async dispatch(fill: AggregatedFill): Promise<void> {
    await this.ensureCacheFresh();

    if (this.subscriptionCache.length === 0) return;

    for (const sub of this.subscriptionCache) {
      if (!this.matchesFilters(fill, sub)) continue;

      // Deduplicate — in-memory first (no DB hit), then atomic insert.
      const dedupKey = `${sub.id}|${fill.eventId}`;
      if (this.recentAlerts.has(dedupKey)) continue;

      const sentResult = await markAlertSent(
        () =>
          prismaTelegram.telegramFillSentAlert.create({
            data: { subscriptionId: sub.id, eventId: fill.eventId },
          }),
        CONTEXT
      );
      this.recentAlerts.add(dedupKey);
      // 'duplicate' → already sent, skip. 'new'/'error' → send (fail open on DB error).
      if (sentResult === 'duplicate') continue;

      // Format message and broadcast via /ws.
      try {
        const message = formatFillAlert(fill, sub.name);
        InternalWebSocketServer.getInstance().broadcastFillAlert(sub.telegramId, message);

        logDeduplicator.info('TelegramFillAlertDispatcherService: Alert dispatched', {
          telegramId: sub.telegramId,
          eventId: fill.eventId,
          source: fill.source,
          coin: fill.coin,
          notionalUsd: fill.notionalUsd,
        });
      } catch (error) {
        logDeduplicator.error('TelegramFillAlertDispatcherService: Failed to broadcast alert', {
          error: error instanceof Error ? error.message : String(error),
          subscriptionId: sub.id,
          eventId: fill.eventId,
        });
      }
    }
  }

  /**
   * Check if a fill matches a subscription's filters.
   */
  private matchesFilters(fill: AggregatedFill, sub: ActiveFillSubscription): boolean {
    // Filter by minimum notional USD.
    if (sub.minUsd > 0 && fill.notionalUsd < sub.minUsd) {
      return false;
    }

    // Filter by maximum notional USD (null/0 = no cap).
    if (sub.maxUsd != null && sub.maxUsd > 0 && fill.notionalUsd > sub.maxUsd) {
      return false;
    }

    // Filter by coin (case-insensitive).
    if (sub.filterCoins.length > 0) {
      const coinLower = fill.coin.toLowerCase();
      if (!sub.filterCoins.some((c) => c.toLowerCase() === coinLower)) {
        return false;
      }
    }

    // Filter by wallet (compare lowercase — fill.wallet is already lowercase).
    if (sub.filterWallets.length > 0) {
      if (!sub.filterWallets.some((w) => w.toLowerCase() === fill.wallet)) {
        return false;
      }
    }

    // Filter by side: 'BUY' → 'B', 'SELL' → 'A'.
    if (sub.filterSide === 'BUY' && fill.side !== 'B') return false;
    if (sub.filterSide === 'SELL' && fill.side !== 'A') return false;

    // Filter by source: PERP | SPOT.
    if (sub.filterSource === 'PERP' && fill.source !== 'perp') return false;
    if (sub.filterSource === 'SPOT' && fill.source !== 'spot') return false;

    // Filter by direction (perp only). If the sub explicitly demands a direction
    // and the fill is spot or has no `dir`, exclude it.
    if (sub.filterDirection != null) {
      if (fill.source !== 'perp' || !fill.dir) return false;
      const isOpen = fill.dir.includes('Open');
      const isClose = fill.dir.includes('Close');
      if (sub.filterDirection === 'OPEN' && !isOpen) return false;
      if (sub.filterDirection === 'CLOSE' && !isClose) return false;
    }

    return true;
  }
}
