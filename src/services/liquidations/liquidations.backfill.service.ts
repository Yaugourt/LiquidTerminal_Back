import { historicalLiquidationRepository } from '../../repositories';
import { HLIndexerLiquidationsClient } from '../../clients/hlindexer/liquidations/liquidations.client';
import { Liquidation } from '../../types/liquidations.types';
import { RawLiquidationCreateInput } from '../../types/historical.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import type { Prisma } from '../../../prisma-historical/generated/client';

/**
 * Backfill status for monitoring
 */
export type BackfillStatus = 'idle' | 'running' | 'completed' | 'error';

export interface BackfillStats {
  status: BackfillStatus;
  pagesLoaded: number;
  totalInserted: number;
  totalDuplicatesSkipped: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

/**
 * Liquidations Backfill Service
 *
 * Runs once at startup to backfill historical liquidation data
 * from the HypeDexer REST API into the historical database.
 *
 * Uses keyset pagination (cursor) to page through all available data,
 * starting from the most recent and going backwards.
 * Stops when encountering mostly duplicates (data already in DB).
 *
 * Respects the HypeDexer rate limiter (10 weight/req, 1000 weight/min).
 */
export class LiquidationsBackfillService {
  private static instance: LiquidationsBackfillService;

  // Configuration
  private static readonly PAGE_SIZE = 1000;
  private static readonly BASE_DELAY_MS = 700; // 85 req/min × 10 weight = 850 weight/min (under 1000 limit)
  private static readonly MAX_DELAY_MS = 10000;
  private static readonly MAX_PAGES = 500; // Safety limit
  private static readonly DUPLICATE_THRESHOLD = 0.9; // Stop when 90%+ of a page are duplicates

  // State
  private status: BackfillStatus = 'idle';
  private pagesLoaded = 0;
  private totalInserted = 0;
  private totalDuplicatesSkipped = 0;
  private startedAt: Date | null = null;
  private completedAt: Date | null = null;
  private lastError: string | null = null;
  private isRunning = false;
  private currentDelayMs = LiquidationsBackfillService.BASE_DELAY_MS;

  private readonly client: HLIndexerLiquidationsClient;
  private readonly repository = historicalLiquidationRepository;

  private constructor() {
    this.client = HLIndexerLiquidationsClient.getInstance();
    logDeduplicator.info('LiquidationsBackfillService: Initialized');
  }

  public static getInstance(): LiquidationsBackfillService {
    if (!LiquidationsBackfillService.instance) {
      LiquidationsBackfillService.instance = new LiquidationsBackfillService();
    }
    return LiquidationsBackfillService.instance;
  }

  /**
   * Start the backfill process (returns a Promise that resolves when complete)
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logDeduplicator.warn('LiquidationsBackfillService: Already running');
      return;
    }

    await this.runBackfill();
  }

  /**
   * Stop the backfill (sets flag to halt on next page)
   */
  public stop(): void {
    this.isRunning = false;
    logDeduplicator.info('LiquidationsBackfillService: Stop requested');
  }

  /**
   * Get backfill statistics for monitoring
   */
  public getStats(): BackfillStats {
    return {
      status: this.status,
      pagesLoaded: this.pagesLoaded,
      totalInserted: this.totalInserted,
      totalDuplicatesSkipped: this.totalDuplicatesSkipped,
      startedAt: this.startedAt?.toISOString() ?? null,
      completedAt: this.completedAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Map a Liquidation (REST format) to the repository input format
   */
  private toCreateInput(liq: Liquidation): RawLiquidationCreateInput {
    return {
      tid: BigInt(liq.tid),
      time: new Date(liq.time),
      timeMs: BigInt(liq.time_ms),
      coin: liq.coin,
      hash: liq.hash,
      liquidatedUser: liq.liquidated_user,
      sizeTotal: liq.size_total,
      notionalTotal: liq.notional_total,
      fillPxVwap: liq.fill_px_vwap,
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
   * Main backfill loop
   */
  private async runBackfill(): Promise<void> {
    this.isRunning = true;
    this.status = 'running';
    this.startedAt = new Date();
    this.pagesLoaded = 0;
    this.totalInserted = 0;
    this.totalDuplicatesSkipped = 0;
    this.lastError = null;
    this.currentDelayMs = LiquidationsBackfillService.BASE_DELAY_MS;

    // Log existing row count for context
    try {
      const existingCount = await this.repository.count();
      logDeduplicator.info('LiquidationsBackfillService: Starting backfill', {
        existingRows: existingCount,
      });
    } catch {
      logDeduplicator.info('LiquidationsBackfillService: Starting backfill (could not read existing count)');
    }

    try {
      let cursor: string | undefined;
      let hasMore = true;

      while (hasMore && this.isRunning && this.pagesLoaded < LiquidationsBackfillService.MAX_PAGES) {
        // Fetch a page from HypeDexer REST API
        let response;
        try {
          response = await this.client.getLiquidations({
            limit: LiquidationsBackfillService.PAGE_SIZE,
            order: 'DESC',
            cursor,
          });
        } catch (fetchError: unknown) {
          // Adaptive backoff on fetch error (429, network, etc.)
          const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
          const is429 = errMsg.includes('429') || errMsg.toLowerCase().includes('rate');

          this.currentDelayMs = Math.min(
            this.currentDelayMs * 2,
            LiquidationsBackfillService.MAX_DELAY_MS
          );

          logDeduplicator.warn('LiquidationsBackfillService: Fetch error, backing off', {
            error: errMsg,
            is429,
            nextDelayMs: this.currentDelayMs,
            page: this.pagesLoaded + 1,
          });

          await this.delay(this.currentDelayMs);
          continue;
        }

        if (!response.success || !response.data || response.data.length === 0) {
          logDeduplicator.info('LiquidationsBackfillService: No more data available', {
            pagesLoaded: this.pagesLoaded,
          });
          break;
        }

        this.pagesLoaded++;

        // Reset delay on successful fetch
        this.currentDelayMs = LiquidationsBackfillService.BASE_DELAY_MS;

        // Normalize liq_dir (REST API may send lowercase)
        const normalizedData = response.data.map((liq) => ({
          ...liq,
          liq_dir: (String(liq.liq_dir).toLowerCase() === 'long' ? 'Long'
            : String(liq.liq_dir).toLowerCase() === 'short' ? 'Short'
            : liq.liq_dir) as 'Long' | 'Short',
        }));

        // Insert batch via repository
        const { inserted, duplicatesSkipped } = await this.insertBatch(normalizedData);

        this.totalInserted += inserted;
        this.totalDuplicatesSkipped += duplicatesSkipped;

        logDeduplicator.info('LiquidationsBackfillService: Page processed', {
          page: this.pagesLoaded,
          fetched: response.data.length,
          inserted,
          duplicatesSkipped,
          totalInserted: this.totalInserted,
        });

        // Check duplicate threshold — if most of the page is duplicates, we've caught up
        const duplicateRatio = response.data.length > 0 ? duplicatesSkipped / response.data.length : 0;
        if (duplicateRatio >= LiquidationsBackfillService.DUPLICATE_THRESHOLD && this.pagesLoaded > 1) {
          logDeduplicator.info('LiquidationsBackfillService: Reached existing data (duplicate threshold hit)', {
            duplicateRatio: Math.round(duplicateRatio * 100) + '%',
          });
          break;
        }

        // Check if there are more pages
        hasMore = response.has_more;
        cursor = response.next_cursor ?? undefined;

        // Rate limit delay between pages
        if (hasMore && this.isRunning) {
          await this.delay(this.currentDelayMs);
        }
      }

      this.status = 'completed';
      this.completedAt = new Date();

      logDeduplicator.info('LiquidationsBackfillService: Backfill completed', {
        pagesLoaded: this.pagesLoaded,
        totalInserted: this.totalInserted,
        totalDuplicatesSkipped: this.totalDuplicatesSkipped,
        durationMs: this.completedAt.getTime() - this.startedAt!.getTime(),
      });
    } catch (error) {
      this.status = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.completedAt = new Date();

      logDeduplicator.error('LiquidationsBackfillService: Backfill failed', {
        error: this.lastError,
        pagesLoaded: this.pagesLoaded,
        totalInserted: this.totalInserted,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Insert a batch of liquidations via the repository
   */
  private async insertBatch(liquidations: Liquidation[]): Promise<{ inserted: number; duplicatesSkipped: number }> {
    const data = liquidations.map((liq) => this.toCreateInput(liq));

    const result = await this.repository.createMany(data);

    const inserted = result.count;
    const duplicatesSkipped = liquidations.length - inserted;

    // Update ingestion state watermark
    if (inserted > 0) {
      const maxTid = liquidations.reduce((max, l) => l.tid > max ? l.tid : max, liquidations[0].tid);
      const maxTimeMs = liquidations.reduce((max, l) => l.time_ms > max ? l.time_ms : max, liquidations[0].time_ms);

      try {
        await this.repository.upsertIngestionState(BigInt(maxTid), BigInt(maxTimeMs), inserted);
      } catch (error) {
        logDeduplicator.error('LiquidationsBackfillService: Failed to update ingestion state', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { inserted, duplicatesSkipped };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
