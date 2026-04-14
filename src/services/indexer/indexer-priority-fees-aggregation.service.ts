import { cacheService } from '../../core/cache.service';
import {
  HYPEDEXER_PRIORITY_FEES_CACHE_KEYS,
  HYPEDEXER_TTL,
} from '../../constants/hypedexer.cache';
import { IndexerFillsService } from './indexer-fills.service';
import { unwrapHypeDexerApiPayload } from '../../utils/hypedexer-api-response.util';
import { logDeduplicator } from '../../utils/logDeduplicator';

/** HypeDexer `GET /fills/` rejects `limit` above 1000 (422). */
const PAGE_LIMIT = 1000;
const MAX_SCAN_ROWS = 50_000;
/** Stay under common reverse-proxy timeouts (e.g. ~60s on Railway) while paginating upstream. */
const COMPUTE_BUDGET_MS = 45_000;

/**
 * Max pages (× PAGE_LIMIT rows) per chart bucket. Scales down when there are many buckets so
 * total upstream calls stay bounded. A single global DESC scan piles rows into the newest bucket only;
 * per-bucket windows keep the series shape honest under the same budget.
 */
function maxPagesPerBucket(numBuckets: number): number {
  if (numBuckets <= 24) {
    return Math.min(18, Math.max(5, Math.floor(120 / numBuckets)));
  }
  if (numBuckets <= 48) {
    return Math.min(12, Math.max(3, Math.floor(80 / numBuckets)));
  }
  if (numBuckets <= 96) {
    return Math.min(6, Math.max(2, Math.floor(100 / numBuckets)));
  }
  return Math.max(1, Math.min(3, Math.floor(120 / numBuckets)));
}

export interface PriorityFeesFillsTimeseriesBucket {
  bucketStart: string;
  totalGas: number;
  fillCount: number;
}

export interface PriorityFeesFillsTimeseriesResult {
  bucketHours: number;
  window: { start: string; end: string };
  buckets: PriorityFeesFillsTimeseriesBucket[];
  partial: boolean;
  scannedRows: number;
  /** Present when partial is true due to time budget or upstream failure (not row-cap only). */
  computationNote?: string;
}

function toIsoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function extractFillsRows(body: unknown): Record<string, unknown>[] {
  const leaf = unwrapHypeDexerApiPayload(body);
  if (Array.isArray(leaf)) {
    return leaf as Record<string, unknown>[];
  }
  if (leaf && typeof leaf === 'object' && !Array.isArray(leaf)) {
    const o = leaf as Record<string, unknown>;
    if (Array.isArray(o.data)) {
      return o.data as Record<string, unknown>[];
    }
    if (Array.isArray(o.rows)) {
      return o.rows as Record<string, unknown>[];
    }
    if (Array.isArray(o.fills)) {
      return o.fills as Record<string, unknown>[];
    }
  }
  return [];
}

function rowTimeMs(row: Record<string, unknown>): number | null {
  const t = row.time;
  if (typeof t === 'number' && Number.isFinite(t)) {
    return t < 1e12 ? t * 1000 : t;
  }
  if (typeof t === 'string' && t.trim() !== '') {
    const n = Number(t);
    if (Number.isFinite(n)) {
      return n < 1e12 ? n * 1000 : n;
    }
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

function rowPriorityGas(row: Record<string, unknown>): number {
  const raw = row.priorityGas ?? row.priority_gas;
  if (raw === null || raw === undefined) {
    return 0;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Aggregates perp+spot fills with priority gas into fixed-width time buckets for charting.
 * Uses HypeDexer `GET /fills/` with time window + pagination; responses cached briefly.
 */
export class IndexerPriorityFeesAggregationService {
  private static instance: IndexerPriorityFeesAggregationService;
  private readonly fills = IndexerFillsService.getInstance();

  public static getInstance(): IndexerPriorityFeesAggregationService {
    if (!IndexerPriorityFeesAggregationService.instance) {
      IndexerPriorityFeesAggregationService.instance = new IndexerPriorityFeesAggregationService();
    }
    return IndexerPriorityFeesAggregationService.instance;
  }

  public async getFillsPriorityGasTimeseries(params: {
    hours: number;
    bucketHours: 1 | 6 | 24;
  }): Promise<PriorityFeesFillsTimeseriesResult> {
    const { hours, bucketHours } = params;
    const cacheKey = HYPEDEXER_PRIORITY_FEES_CACHE_KEYS.fillsTimeseries(hours, bucketHours);

    try {
      return await cacheService.getOrSet(
        cacheKey,
        () => this.computeFillsPriorityGasTimeseries(params),
        HYPEDEXER_TTL.priorityFeesFillsTimeseries
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDeduplicator.error('Priority fees fills timeseries unavailable (cache or compute)', {
        hours,
        bucketHours,
        errorMessage: message,
      });
      return this.buildEmptyShellTimeseriesResult(
        params,
        `Service temporarily unavailable: ${message}`
      );
    }
  }

  /**
   * Zero-filled buckets for the requested window — avoids 502 when cache or compute throws.
   */
  private buildEmptyShellTimeseriesResult(
    params: { hours: number; bucketHours: 1 | 6 | 24 },
    computationNote: string
  ): PriorityFeesFillsTimeseriesResult {
    const { hours, bucketHours } = params;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const startIso = toIsoUtc(start);
    const endIso = toIsoUtc(end);
    const windowStartMs = start.getTime();
    const windowEndMs = end.getTime();
    const bucketMs = bucketHours * 3600 * 1000;
    const numBuckets = Math.max(1, Math.ceil((windowEndMs - windowStartMs) / bucketMs));
    const buckets: PriorityFeesFillsTimeseriesBucket[] = [];
    for (let i = 0; i < numBuckets; i++) {
      const bucketStartMs = windowStartMs + i * bucketMs;
      buckets.push({
        bucketStart: toIsoUtc(new Date(bucketStartMs)),
        totalGas: 0,
        fillCount: 0,
      });
    }
    return {
      bucketHours,
      window: { start: startIso, end: endIso },
      buckets,
      partial: true,
      scannedRows: 0,
      computationNote,
    };
  }

  private async computeFillsPriorityGasTimeseries(params: {
    hours: number;
    bucketHours: 1 | 6 | 24;
  }): Promise<PriorityFeesFillsTimeseriesResult> {
    const { hours, bucketHours } = params;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const startIso = toIsoUtc(start);
    const endIso = toIsoUtc(end);
    const windowStartMs = start.getTime();
    const windowEndMs = end.getTime();
    const bucketMs = bucketHours * 3600 * 1000;
    const numBuckets = Math.max(1, Math.ceil((windowEndMs - windowStartMs) / bucketMs));

    const gasByIndex = new Array<number>(numBuckets).fill(0);
    const countByIndex = new Array<number>(numBuckets).fill(0);

    let scannedRows = 0;
    let partial = false;
    let computationNote: string | undefined;
    const computeStarted = Date.now();
    const maxPages = maxPagesPerBucket(numBuckets);
    let bucketCapped = false;

    try {
      bucketLoop: for (let bucketIndex = 0; bucketIndex < numBuckets; bucketIndex++) {
        if (Date.now() - computeStarted > COMPUTE_BUDGET_MS) {
          partial = true;
          computationNote =
            'Stopped early to stay within server time limits; chart may be incomplete.';
          break bucketLoop;
        }
        if (scannedRows >= MAX_SCAN_ROWS) {
          partial = true;
          break bucketLoop;
        }

        const bucketStartMs = windowStartMs + bucketIndex * bucketMs;
        const bucketEndMs =
          bucketIndex === numBuckets - 1
            ? windowEndMs
            : Math.min(windowEndMs, bucketStartMs + bucketMs);
        const bucketStartIso = toIsoUtc(new Date(bucketStartMs));
        const bucketEndIso = toIsoUtc(new Date(bucketEndMs));
        const isLastBucket = bucketIndex === numBuckets - 1;

        let offset = 0;
        let pagesForBucket = 0;

        while (pagesForBucket < maxPages && scannedRows < MAX_SCAN_ROWS) {
          if (Date.now() - computeStarted > COMPUTE_BUDGET_MS) {
            partial = true;
            computationNote =
              computationNote ??
              'Stopped early to stay within server time limits; chart may be incomplete.';
            break bucketLoop;
          }

          let upstream: unknown;
          try {
            upstream = await this.fills.getFills({
              start_time: bucketStartIso,
              end_time: bucketEndIso,
              has_priority_gas: true,
              limit: PAGE_LIMIT,
              offset,
              order: 'ASC',
            });
          } catch (pageError) {
            partial = true;
            computationNote =
              pageError instanceof Error
                ? `Upstream fills request failed: ${pageError.message}`
                : 'Upstream fills request failed.';
            logDeduplicator.warn('Priority fees fills timeseries bucket page error', {
              hours,
              bucketHours,
              bucketIndex,
              offset,
              errorMessage: pageError instanceof Error ? pageError.message : String(pageError),
            });
            break bucketLoop;
          }

          const rows = extractFillsRows(upstream);
          pagesForBucket += 1;

          if (rows.length === 0) {
            break;
          }

          for (const row of rows) {
            const ms = rowTimeMs(row);
            if (ms === null || ms < bucketStartMs) {
              continue;
            }
            // Half-open buckets [start, end) match floor((t - windowStart) / bucketMs); last bucket includes end.
            if (isLastBucket) {
              if (ms > bucketEndMs) continue;
            } else if (ms >= bucketEndMs) {
              continue;
            }
            gasByIndex[bucketIndex] += rowPriorityGas(row);
            countByIndex[bucketIndex] += 1;
          }

          scannedRows += rows.length;

          if (rows.length < PAGE_LIMIT) {
            break;
          }

          offset += PAGE_LIMIT;

          if (pagesForBucket >= maxPages && rows.length === PAGE_LIMIT) {
            bucketCapped = true;
            partial = true;
          }
        }
      }

      if (bucketCapped && !computationNote) {
        computationNote = `Some buckets may be capped at ~${maxPages * PAGE_LIMIT} fills per interval (high volume).`;
      }
    } catch (unexpected) {
      partial = true;
      computationNote =
        unexpected instanceof Error ? unexpected.message : 'Unexpected aggregation error.';
      logDeduplicator.error('Priority fees fills timeseries compute failed', {
        hours,
        bucketHours,
        errorMessage: unexpected instanceof Error ? unexpected.message : String(unexpected),
      });
    }

    const buckets: PriorityFeesFillsTimeseriesBucket[] = [];
    for (let i = 0; i < numBuckets; i++) {
      const bucketStartMs = windowStartMs + i * bucketMs;
      buckets.push({
        bucketStart: toIsoUtc(new Date(bucketStartMs)),
        totalGas: gasByIndex[i] ?? 0,
        fillCount: countByIndex[i] ?? 0,
      });
    }

    logDeduplicator.info('Priority fees fills timeseries computed', {
      hours,
      bucketHours,
      scannedRows,
      partial,
      bucketCount: buckets.length,
      computationNote,
    });

    return {
      bucketHours,
      window: { start: startIso, end: endIso },
      buckets,
      partial,
      scannedRows,
      computationNote,
    };
  }
}
