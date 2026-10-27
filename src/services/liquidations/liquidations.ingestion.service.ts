import { historicalLiquidationRepository } from '../../repositories';
import { LiquidationsWebSocketService } from './liquidations.ws.service';
import { Liquidation } from '../../types/liquidations.types';
import { RawLiquidationCreateInput } from '../../types/historical.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import type { Prisma } from '../../../prisma-historical/generated/client';

/**
 * Ingestion statistics for monitoring
 */
export interface IngestionStats {
  totalIngested: number;
  totalErrors: number;
  totalDuplicatesSkipped: number;
  totalInvalid: number;
  batchesFlushed: number;
  pendingBatchSize: number;
  isIngesting: boolean;
  lastFlushAt: string | null;
  lastTid: number | null;
  lastTimeMs: number | null;
}

/**
 * Liquidations Ingestion Service
 *
 * Persists raw liquidation data from the WebSocket pipeline to the historical database.
 * Uses batch inserts with createMany + skipDuplicates for idempotent writes.
 *
 * Complete error isolation: DB failures are logged but never propagated to the WS pipeline.
 */
export class LiquidationsIngestionService {
  private static instance: LiquidationsIngestionService;

  // Batch configuration
  private static readonly BATCH_FLUSH_INTERVAL_MS = 2000;
  private static readonly MAX_BATCH_SIZE = 100;
  // A failed batch is kept and retried (inserts skip duplicates, so a retry is safe).
  // Bounded both ways: after MAX_FLUSH_ATTEMPTS consecutive failures the batch is dropped
  // (a row the DB always rejects must not wedge ingestion), and the buffer never holds more
  // than MAX_PENDING_ROWS, so a dead DB cannot grow memory. Older gaps are left to the backfill.
  private static readonly MAX_FLUSH_ATTEMPTS = 10;
  private static readonly MAX_PENDING_ROWS = 1000;
  private static readonly RETRY_BACKOFF_MS = 2000;
  private static readonly RETRY_BACKOFF_MAX_MS = 10_000;

  // State
  private pendingBatch: Liquidation[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private consecutiveFlushFailures = 0;
  private retryNotBefore = 0;
  private unsubscribe: (() => void) | null = null;
  private isRunning = false;

  // Repository
  private readonly repository = historicalLiquidationRepository;

  // Stats counters
  private totalIngested = 0;
  private totalErrors = 0;
  private totalDuplicatesSkipped = 0;
  private totalInvalid = 0;
  private batchesFlushed = 0;
  private lastFlushAt: Date | null = null;
  private lastTid: number | null = null;
  private lastTimeMs: number | null = null;

  private constructor() {
    logDeduplicator.info('LiquidationsIngestionService: Initialized');
  }

  public static getInstance(): LiquidationsIngestionService {
    if (!LiquidationsIngestionService.instance) {
      LiquidationsIngestionService.instance = new LiquidationsIngestionService();
    }
    return LiquidationsIngestionService.instance;
  }

  /**
   * Start ingestion: subscribe to raw liquidations from WebSocket and begin batch persistence
   */
  public start(): void {
    if (this.isRunning) {
      logDeduplicator.warn('LiquidationsIngestionService: Already running');
      return;
    }

    this.isRunning = true;

    // Subscribe to raw (pre-aggregation) liquidations
    const wsService = LiquidationsWebSocketService.getInstance();
    this.unsubscribe = wsService.onRawLiquidation((liquidations) => {
      this.bufferLiquidations(liquidations);
    });

    // Start periodic flush timer
    this.flushTimer = setInterval(() => {
      this.flushBatch();
    }, LiquidationsIngestionService.BATCH_FLUSH_INTERVAL_MS);

    logDeduplicator.info('LiquidationsIngestionService: Started');
  }

  /**
   * Stop ingestion: unsubscribe, stop timer, flush remaining
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Unsubscribe from WS
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush of remaining batch — await the full chain
    await this.flushBatch();

    logDeduplicator.info('LiquidationsIngestionService: Stopped', {
      totalIngested: this.totalIngested,
      totalErrors: this.totalErrors,
    });
  }

  /**
   * Get ingestion statistics for monitoring
   */
  public getStats(): IngestionStats {
    return {
      totalIngested: this.totalIngested,
      totalErrors: this.totalErrors,
      totalDuplicatesSkipped: this.totalDuplicatesSkipped,
      totalInvalid: this.totalInvalid,
      batchesFlushed: this.batchesFlushed,
      pendingBatchSize: this.pendingBatch.length,
      isIngesting: this.isRunning,
      lastFlushAt: this.lastFlushAt?.toISOString() ?? null,
      lastTid: this.lastTid,
      lastTimeMs: this.lastTimeMs,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Validate a liquidation record before insertion.
   * Lightweight safety net — the WS service already validates upstream.
   */
  private isValidLiquidation(liq: Liquidation): boolean {
    return (
      Number.isInteger(liq.tid) && liq.tid > 0 && // BigInt(tid) throws on a fraction
      Number.isInteger(liq.time_ms) && liq.time_ms > 0 &&
      typeof liq.coin === 'string' && liq.coin.length > 0 &&
      typeof liq.hash === 'string' && liq.hash.length > 0 &&
      typeof liq.liquidated_user === 'string' && liq.liquidated_user.length > 0 &&
      typeof liq.notional_total === 'number' && Number.isFinite(liq.notional_total) &&
      typeof liq.mark_px === 'number' && Number.isFinite(liq.mark_px) && liq.mark_px > 0
      // liq_dir may be 'Long', 'Short' or null: directionless rows are the
      // liquidator lists HypeDexer sends next to a priced liquidation (zero
      // notional). Stored as raw data; the stats queries leave them out.
    );
  }

  /**
   * Map a Liquidation (WS/REST format) to the repository input format
   */
  private toCreateInput(liq: Liquidation): RawLiquidationCreateInput {
    return {
      tid: BigInt(liq.tid),
      time: new Date(liq.time_ms),
      timeMs: BigInt(liq.time_ms),
      coin: liq.coin,
      hash: liq.hash,
      liquidatedUser: liq.liquidated_user,
      sizeTotal: liq.size_total ?? 0,
      notionalTotal: liq.notional_total,
      fillPxVwap: liq.fill_px_vwap ?? liq.mark_px,
      markPx: liq.mark_px,
      method: liq.method,
      feeTotalLiquidated: liq.fee_total_liquidated,
      liquidators: liq.liquidators,
      liquidatorCount: liq.liquidator_count,
      liqDir: liq.liq_dir,
      rawData: liq as unknown as Prisma.InputJsonValue,
    };
  }

  /**
   * Buffer incoming liquidations and trigger flush if batch is full
   */
  private bufferLiquidations(liquidations: Liquidation[]): void {
    const valid = liquidations.filter((liq) => {
      if (this.isValidLiquidation(liq)) return true;
      this.totalInvalid++;
      logDeduplicator.warn('LiquidationsIngestionService: Invalid liquidation skipped', {
        tid: liq.tid,
        coin: liq.coin,
      });
      return false;
    });

    this.pendingBatch.push(...valid);
    this.capPending();

    // Flush immediately if batch is full
    if (this.pendingBatch.length >= LiquidationsIngestionService.MAX_BATCH_SIZE) {
      this.flushBatch();
    }
  }

  /**
   * Queue a flush operation via Promise chain.
   * Guarantees serial execution: concurrent calls queue up instead of being dropped.
   */
  private flushBatch(): Promise<void> {
    this.flushPromise = this.flushPromise.then(() => this.doFlush());
    return this.flushPromise;
  }

  /**
   * Actually flush pending batch to the historical database.
   * NEVER throws — all errors are logged and swallowed.
   */
  private async doFlush(): Promise<void> {
    if (this.pendingBatch.length === 0) {
      return;
    }

    // Back off after a failure; a shutdown flush always tries.
    if (this.isRunning && Date.now() < this.retryNotBefore) {
      return;
    }

    // Take the current batch and reset
    const batch = this.pendingBatch.splice(0);

    try {
      const data = batch.map((liq) => this.toCreateInput(liq));

      const result = await this.repository.createMany(data);

      const inserted = result.count;
      const duplicatesSkipped = batch.length - inserted;

      this.totalIngested += inserted;
      this.totalDuplicatesSkipped += duplicatesSkipped;
      this.batchesFlushed++;
      this.lastFlushAt = new Date();
      this.consecutiveFlushFailures = 0;
      this.retryNotBefore = 0;

      // Track watermark
      const maxTid = batch.reduce((max, l) => l.tid > max ? l.tid : max, batch[0].tid);
      const maxTimeMs = batch.reduce((max, l) => l.time_ms > max ? l.time_ms : max, batch[0].time_ms);
      this.lastTid = maxTid;
      this.lastTimeMs = maxTimeMs;

      // Update ingestion state in DB
      await this.updateIngestionState(BigInt(maxTid), BigInt(maxTimeMs), inserted);

      if (inserted > 0) {
        logDeduplicator.debug('LiquidationsIngestionService: Batch flushed', {
          inserted,
          duplicatesSkipped,
          totalIngested: this.totalIngested,
        });
      }
    } catch (error) {
      this.totalErrors++;
      logDeduplicator.error('LiquidationsIngestionService: Batch flush error', {
        error: error instanceof Error ? error.message : String(error),
        batchSize: batch.length,
        totalErrors: this.totalErrors,
      });
      this.requeueFailedBatch(batch);
    }
  }

  /**
   * Put a failed batch back at the head of the buffer for the next flush, within the
   * attempt and size bounds. Rows that don't fit are dropped (the oldest first).
   */
  private requeueFailedBatch(batch: Liquidation[]): void {
    this.consecutiveFlushFailures++;
    if (this.consecutiveFlushFailures >= LiquidationsIngestionService.MAX_FLUSH_ATTEMPTS) {
      logDeduplicator.error('LiquidationsIngestionService: Batch dropped after repeated failures', {
        batchSize: batch.length,
        attempts: this.consecutiveFlushFailures,
      });
      this.consecutiveFlushFailures = 0;
      this.retryNotBefore = 0;
      return;
    }

    this.retryNotBefore =
      Date.now() +
      Math.min(
        this.consecutiveFlushFailures * LiquidationsIngestionService.RETRY_BACKOFF_MS,
        LiquidationsIngestionService.RETRY_BACKOFF_MAX_MS
      );
    this.pendingBatch.unshift(...batch);
    this.capPending();
  }

  /** Keep the buffer within MAX_PENDING_ROWS, dropping the oldest rows. */
  private capPending(): void {
    const overflow = this.pendingBatch.length - LiquidationsIngestionService.MAX_PENDING_ROWS;
    if (overflow <= 0) return;
    this.pendingBatch.splice(0, overflow);
    logDeduplicator.error('LiquidationsIngestionService: Buffer full while the DB is failing, oldest rows dropped', {
      dropped: overflow,
    });
  }

  /**
   * Update ingestion state watermark in the database
   */
  private async updateIngestionState(lastTid: bigint, lastTimeMs: bigint, newCount: number): Promise<void> {
    try {
      await this.repository.upsertIngestionState(lastTid, lastTimeMs, newCount);
    } catch (error) {
      logDeduplicator.error('LiquidationsIngestionService: Failed to update ingestion state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
