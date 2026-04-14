import { cacheService } from '../../core/cache.service';
import {
  HYPEDEXER_PRIORITY_FEES_CACHE_KEYS,
  HYPEDEXER_TTL,
} from '../../constants/hypedexer.cache';
import { IndexerFillsService } from './indexer-fills.service';
import { unwrapHypeDexerApiPayload } from '../../utils/hypedexer-api-response.util';
import { logDeduplicator } from '../../utils/logDeduplicator';

const PAGE_LIMIT = 2000;
const MAX_SCAN_ROWS = 50_000;

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

    return cacheService.getOrSet(
      cacheKey,
      () => this.computeFillsPriorityGasTimeseries(params),
      HYPEDEXER_TTL.priorityFeesFillsTimeseries
    );
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

    let offset = 0;
    let scannedRows = 0;
    let partial = false;

    while (scannedRows < MAX_SCAN_ROWS) {
      const upstream = await this.fills.getFills({
        start_time: startIso,
        end_time: endIso,
        has_priority_gas: true,
        limit: PAGE_LIMIT,
        offset,
        order: 'DESC',
      });

      const rows = extractFillsRows(upstream);
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const ms = rowTimeMs(row);
        if (ms === null || ms < windowStartMs || ms > windowEndMs) {
          continue;
        }
        const idx = Math.min(
          numBuckets - 1,
          Math.max(0, Math.floor((ms - windowStartMs) / bucketMs))
        );
        gasByIndex[idx] += rowPriorityGas(row);
        countByIndex[idx] += 1;
      }

      scannedRows += rows.length;
      if (rows.length < PAGE_LIMIT) {
        break;
      }
      offset += PAGE_LIMIT;
      if (scannedRows >= MAX_SCAN_ROWS) {
        partial = true;
        break;
      }
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
    });

    return {
      bucketHours,
      window: { start: startIso, end: endIso },
      buckets,
      partial,
      scannedRows,
    };
  }
}
