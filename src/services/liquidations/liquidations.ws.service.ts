import { HypeDexerLiquidationsWSClient } from '../../clients/hypedexer/websocket/liquidations.ws.client';
import { Liquidation, AggregatedLiquidation } from '../../types/liquidations.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';

/**
 * Callback type for processed liquidation events
 */
export type ProcessedLiquidationCallback = (liquidations: AggregatedLiquidation[]) => void;

/**
 * Liquidations WebSocket Service
 * 
 * Bridges HypeDexer WebSocket to internal consumers:
 * - Receives real-time liquidations from HypeDexer WS
 * - Validates and filters data
 * - Aggregates multiple liquidations from same user/coin/direction
 * - Broadcasts to internal WebSocket server and SSE manager
 * 
 * Follows singleton pattern.
 */
export class LiquidationsWebSocketService {
  private static instance: LiquidationsWebSocketService;

  // External WS client
  private readonly hypeDexerClient: HypeDexerLiquidationsWSClient;

  // Callbacks for processed liquidations
  private processedCallbacks: Set<ProcessedLiquidationCallback> = new Set();

  // Deduplication: track recently seen tids to avoid duplicates
  private recentTids: Set<number> = new Set();
  private static readonly MAX_RECENT_TIDS = 10000;
  private static readonly TID_CLEANUP_INTERVAL = 60000; // 1 minute

  // Aggregation settings
  private static readonly MIN_AGGREGATION_COUNT = 2;
  private static readonly AGGREGATION_WINDOW_MS = 1000; // 1 second window for aggregation

  // Pending liquidations for aggregation (grouped by user_coin_dir)
  private pendingAggregation: Map<string, Liquidation[]> = new Map();
  private aggregationTimer: NodeJS.Timeout | null = null;

  // Redis keys for state sync across instances
  private static readonly LAST_TID_KEY = 'liquidations:ws:lastTid';

  private constructor() {
    this.hypeDexerClient = HypeDexerLiquidationsWSClient.getInstance();

    // Register callback for liquidations from HypeDexer
    this.hypeDexerClient.onLiquidation((liquidations) => {
      this.handleIncomingLiquidations(liquidations);
    });

    // Start TID cleanup interval
    setInterval(() => this.cleanupRecentTids(), LiquidationsWebSocketService.TID_CLEANUP_INTERVAL);

    logDeduplicator.info('LiquidationsWebSocketService: Initialized');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): LiquidationsWebSocketService {
    if (!LiquidationsWebSocketService.instance) {
      LiquidationsWebSocketService.instance = new LiquidationsWebSocketService();
    }
    return LiquidationsWebSocketService.instance;
  }

  /**
   * Start the WebSocket service
   * Called by ClientInitializerService
   */
  public start(): void {
    logDeduplicator.info('LiquidationsWebSocketService: Starting');
    this.hypeDexerClient.start();
  }

  /**
   * Stop the WebSocket service
   */
  public stop(): void {
    logDeduplicator.info('LiquidationsWebSocketService: Stopping');
    this.hypeDexerClient.stop();
    this.processedCallbacks.clear();

    if (this.aggregationTimer) {
      clearTimeout(this.aggregationTimer);
      this.aggregationTimer = null;
    }
  }

  /**
   * Register a callback for processed liquidation events
   * Returns unsubscribe function
   */
  public onProcessedLiquidation(callback: ProcessedLiquidationCallback): () => void {
    this.processedCallbacks.add(callback);
    return () => {
      this.processedCallbacks.delete(callback);
    };
  }

  /**
   * Get service statistics
   */
  public getStats(): {
    hypeDexerState: string;
    isSubscribed: boolean;
    callbackCount: number;
    recentTidsCount: number;
    pendingAggregationCount: number;
  } {
    const hypeDexerStats = this.hypeDexerClient.getStats();
    return {
      hypeDexerState: hypeDexerStats.state,
      isSubscribed: hypeDexerStats.isSubscribed,
      callbackCount: this.processedCallbacks.size,
      recentTidsCount: this.recentTids.size,
      pendingAggregationCount: this.pendingAggregation.size,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Handle incoming liquidations from HypeDexer
   */
  private handleIncomingLiquidations(liquidations: Liquidation[]): void {
    // Filter out duplicates and invalid data
    const validLiquidations = liquidations.filter((liq) => this.validateAndDedupe(liq));

    if (validLiquidations.length === 0) {
      return;
    }

    logDeduplicator.info('LiquidationsWebSocketService: Processing liquidations', {
      received: liquidations.length,
      valid: validLiquidations.length,
    });

    // Add to aggregation buffer
    for (const liq of validLiquidations) {
      this.addToAggregationBuffer(liq);
    }

    // Schedule aggregation flush if not already scheduled
    this.scheduleAggregationFlush();
  }

  /**
   * Validate liquidation and check for duplicates
   */
  private validateAndDedupe(liq: Liquidation): boolean {
    // Check for duplicate tid
    if (this.recentTids.has(liq.tid)) {
      return false;
    }

    // Validate required fields
    if (!liq.tid || !liq.coin || !liq.hash || !liq.liquidated_user) {
      logDeduplicator.warn('LiquidationsWebSocketService: Invalid liquidation data', {
        tid: liq.tid,
        coin: liq.coin,
      });
      return false;
    }

    // Validate numeric fields
    if (
      !Number.isFinite(liq.notional_total) ||
      liq.notional_total < 0 ||
      !Number.isFinite(liq.mark_px) ||
      liq.mark_px <= 0
    ) {
      logDeduplicator.warn('LiquidationsWebSocketService: Invalid numeric values', {
        tid: liq.tid,
        notional_total: liq.notional_total,
        mark_px: liq.mark_px,
      });
      return false;
    }

    // Mark as seen
    this.recentTids.add(liq.tid);

    return true;
  }

  /**
   * Add liquidation to aggregation buffer
   */
  private addToAggregationBuffer(liq: Liquidation): void {
    const key = `${liq.liquidated_user}_${liq.coin}_${liq.liq_dir}`;

    if (!this.pendingAggregation.has(key)) {
      this.pendingAggregation.set(key, []);
    }

    this.pendingAggregation.get(key)!.push(liq);
  }

  /**
   * Schedule aggregation flush
   */
  private scheduleAggregationFlush(): void {
    if (this.aggregationTimer) {
      return; // Already scheduled
    }

    this.aggregationTimer = setTimeout(() => {
      this.aggregationTimer = null;
      this.flushAggregation();
    }, LiquidationsWebSocketService.AGGREGATION_WINDOW_MS);
  }

  /**
   * Flush aggregation buffer and broadcast
   */
  private flushAggregation(): void {
    if (this.pendingAggregation.size === 0) {
      return;
    }

    const result: AggregatedLiquidation[] = [];

    for (const [, liquidations] of this.pendingAggregation) {
      // Always aggregate (even single liquidations get metadata)
      const aggregated = this.createAggregatedLiquidation(liquidations);
      result.push(aggregated);
    }

    // Clear buffer
    this.pendingAggregation.clear();

    if (result.length === 0) {
      return;
    }

    // Sort by time_ms
    result.sort((a, b) => a.time_ms - b.time_ms);

    logDeduplicator.info('LiquidationsWebSocketService: Broadcasting aggregated liquidations', {
      count: result.length,
    });

    // Update last seen tid in Redis
    this.updateLastTid(result);

    // Notify all callbacks
    for (const callback of this.processedCallbacks) {
      try {
        callback(result);
      } catch (error) {
        logDeduplicator.error('LiquidationsWebSocketService: Callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Create aggregated liquidation from multiple liquidations
   * (Same logic as in liquidations.service.ts)
   */
  private createAggregatedLiquidation(liquidations: Liquidation[]): AggregatedLiquidation {
    // Sort by time_ms ascending
    const sorted = [...liquidations].sort((a, b) => a.time_ms - b.time_ms);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    // Calculate sums
    let totalNotional = 0;
    let totalSize = 0;
    let totalFeeToLiquidated = 0;
    const allTids: number[] = [];
    const liquidatorsSet = new Set<string>();

    for (const liq of sorted) {
      totalNotional += liq.notional_total;
      totalSize += liq.size_total;
      totalFeeToLiquidated += liq.fee_total_liquidated;
      allTids.push(liq.tid);

      for (const liquidator of liq.liquidators) {
        liquidatorsSet.add(liquidator);
      }
    }

    // Calculate weighted average prices
    let weightedMarkPx = 0;
    let weightedFillPx = 0;

    for (const liq of sorted) {
      const weight = liq.size_total / totalSize;
      weightedMarkPx += liq.mark_px * weight;
      weightedFillPx += liq.fill_px_vwap * weight;
    }

    const aggregated: AggregatedLiquidation = {
      time: first.time,
      time_ms: first.time_ms,
      coin: first.coin,
      hash: first.hash,
      liquidated_user: first.liquidated_user,
      liq_dir: first.liq_dir,
      method: first.method,

      // Aggregated values
      size_total: Math.round(totalSize * 100) / 100,
      notional_total: Math.round(totalNotional * 100) / 100,
      fill_px_vwap: Math.round(weightedFillPx * 100) / 100,
      mark_px: Math.round(weightedMarkPx * 100) / 100,
      fee_total_liquidated: Math.round(totalFeeToLiquidated * 100) / 100,

      liquidators: Array.from(liquidatorsSet),
      liquidator_count: liquidatorsSet.size,
      tid: first.tid,

      // Aggregation metadata
      aggregation: {
        isAggregated: sorted.length > 1,
        count: sorted.length,
        timeRangeMs: [first.time_ms, last.time_ms],
        originalTids: allTids,
        totalNotional: Math.round(totalNotional * 100) / 100,
        totalSize: Math.round(totalSize * 100) / 100,
        avgMarkPrice: Math.round(weightedMarkPx * 100) / 100,
        avgFillPrice: Math.round(weightedFillPx * 100) / 100,
        uniqueLiquidators: Array.from(liquidatorsSet),
      },
    };

    return aggregated;
  }

  /**
   * Update last seen tid in Redis for multi-instance sync
   */
  private async updateLastTid(liquidations: AggregatedLiquidation[]): Promise<void> {
    try {
      const maxTid = Math.max(...liquidations.map((l) => l.tid));
      await redisService.set(LiquidationsWebSocketService.LAST_TID_KEY, maxTid.toString());
    } catch (error) {
      logDeduplicator.warn('LiquidationsWebSocketService: Failed to update last tid', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cleanup old tids from deduplication set
   */
  private cleanupRecentTids(): void {
    if (this.recentTids.size > LiquidationsWebSocketService.MAX_RECENT_TIDS) {
      // Keep only the last half
      const tidsArray = Array.from(this.recentTids);
      const toKeep = tidsArray.slice(-LiquidationsWebSocketService.MAX_RECENT_TIDS / 2);
      this.recentTids = new Set(toKeep);

      logDeduplicator.info('LiquidationsWebSocketService: Cleaned up recent tids', {
        before: tidsArray.length,
        after: this.recentTids.size,
      });
    }
  }
}
