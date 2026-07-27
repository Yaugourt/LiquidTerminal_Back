import {
  PriorityFeesSeries,
  PriorityFeesTotals,
  PriorityFeesWindow,
} from '../../types/priorityFees.types';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HypeDexerAnalyticsIndexerClient } from '../../clients/hypedexer/rest/analytics/analytics-indexer.client';
import {
  BUCKET_SECONDS,
  CumulativeRollup,
  UPSTREAM_MAX_WINDOW_HOURS,
  bucketLadder,
  computeBuckets,
} from './priorityFees.series';

const SERIES_CACHE_PREFIX = 'priority-fees:series:';
const SERIES_CACHE_TTL_SECONDS: Record<PriorityFeesWindow, number> = {
  '24h': 5 * 60,
  '7d': 15 * 60,
};

const PERP_MARKETS_CACHE_KEY = 'perp:markets';

/**
 * Rollups fired at once. The upstream analytics lane allows 100 requests a
 * minute; a window costs at most 29 of them and only on a cache miss, so the
 * cap here is about not opening thirty sockets in one tick rather than about
 * the quota.
 */
const FANOUT_CONCURRENCY = 6;

const WINDOW_HOURS: Record<PriorityFeesWindow, number> = {
  '24h': 24,
  '7d': UPSTREAM_MAX_WINDOW_HOURS,
};

interface PerpMarketLite {
  name: string;
  price: number;
}

/** `/analytics/priority-fees/stats` — only the fields we read. */
interface PriorityStatsPayload {
  total_priority_gas?: number;
  total_fills_with_priority?: number;
  avg_priority_gas?: number;
  min_priority_gas?: number;
  max_priority_gas?: number;
  unique_users?: number;
  time_range?: { start?: string; end?: string };
}

/** `/analytics/fills/stats` — the denominators. */
interface FillsStatsPayload {
  total_fills?: number;
  unique_users?: number;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Upstream stamps are ISO-8601 and already UTC, with or without the suffix. */
function parseUpstreamMs(iso: string | undefined): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Run `task` over `items`, at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await Promise.allSettled([task(items[index])]).then((r) => r[0]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Hourly priority-fee burn, rebuilt from cumulative rollups.
 *
 * The upstream serves a pre-aggregated daily chart, but it stopped advancing on
 * 2026-07-11 and answers 200 with a frozen payload, so it cannot be the source
 * for a live view. Its `stats` rollup is computed on the fly and stays current;
 * asking it for every lookback from one hour to the window edge and differencing
 * neighbouring answers reconstructs the series it no longer publishes.
 */
export class PriorityFeesService {
  private static instance: PriorityFeesService;

  private analyticsClient = HypeDexerAnalyticsIndexerClient.getInstance();

  private constructor() {}

  public static getInstance(): PriorityFeesService {
    if (!PriorityFeesService.instance) {
      PriorityFeesService.instance = new PriorityFeesService();
    }
    return PriorityFeesService.instance;
  }

  public async getSeries(window: PriorityFeesWindow): Promise<PriorityFeesSeries> {
    const cacheKey = `${SERIES_CACHE_PREFIX}${window}`;
    const cached = await redisService.get(cacheKey);
    if (cached) return JSON.parse(cached) as PriorityFeesSeries;

    const series = await this.buildSeries(window);
    await redisService.set(cacheKey, JSON.stringify(series), SERIES_CACHE_TTL_SECONDS[window]);
    return series;
  }

  private async buildSeries(window: PriorityFeesWindow): Promise<PriorityFeesSeries> {
    const ladder = bucketLadder(window);

    const [rollupResults, fillsStats, hypeUsd] = await Promise.all([
      mapWithConcurrency(ladder, FANOUT_CONCURRENCY, (hours) => this.fetchRollup(hours)),
      this.fetchFillsStats(WINDOW_HOURS[window]),
      this.readHypeUsd(),
    ]);

    const rollups: CumulativeRollup[] = [];
    let missingBuckets = 0;
    for (const result of rollupResults) {
      if (result.status === 'fulfilled' && result.value !== null) rollups.push(result.value);
      else missingBuckets++;
    }

    if (rollups.length === 0) {
      throw new Error('No priority-fee rollup could be fetched');
    }

    if (missingBuckets > 0) {
      logDeduplicator.warn('PriorityFeesService: some rollups failed', { window, missingBuckets });
    }

    // The widest rollup covers the whole window, so it is the only answer that
    // can carry the aggregates differencing destroys.
    const widest = rollups.reduce((a, b) => (b.hours > a.hours ? b : a));

    return {
      window,
      bucketSeconds: BUCKET_SECONDS[window],
      buckets: computeBuckets(rollups),
      totals: this.buildTotals(widest, fillsStats),
      meta: {
        hypeUsd,
        generatedAt: Date.now(),
        maxWindowHours: UPSTREAM_MAX_WINDOW_HOURS,
        missingBuckets,
      },
    };
  }

  private buildTotals(
    widest: CumulativeRollup & { raw?: PriorityStatsPayload },
    fillsStats: FillsStatsPayload | null
  ): PriorityFeesTotals {
    const raw = widest.raw ?? {};
    return {
      gas: widest.gas,
      fills: widest.fills,
      uniqueUsers: finite(raw.unique_users) ?? 0,
      avgGas: finite(raw.avg_priority_gas) ?? 0,
      minGas: finite(raw.min_priority_gas) ?? 0,
      maxGas: finite(raw.max_priority_gas) ?? 0,
      allFills: fillsStats ? finite(fillsStats.total_fills) : null,
      allUsers: fillsStats ? finite(fillsStats.unique_users) : null,
    };
  }

  private async fetchRollup(
    hours: number
  ): Promise<(CumulativeRollup & { raw: PriorityStatsPayload }) | null> {
    const payload = (await this.analyticsClient.getPriorityFeesStats({
      hours,
    })) as PriorityStatsPayload | null;
    if (!payload || typeof payload !== 'object') return null;

    const gas = finite(payload.total_priority_gas);
    const fills = finite(payload.total_fills_with_priority);
    const startMs = parseUpstreamMs(payload.time_range?.start);
    const endMs = parseUpstreamMs(payload.time_range?.end);
    if (gas === null || fills === null || startMs === null || endMs === null) return null;

    return { hours, startMs, endMs, gas, fills, raw: payload };
  }

  /**
   * Venue-wide fills over the same window, so the client can say what share of
   * activity pays for priority instead of just how much priority costs.
   */
  private async fetchFillsStats(hours: number): Promise<FillsStatsPayload | null> {
    try {
      const payload = (await this.analyticsClient.getFillsStats({ hours })) as FillsStatsPayload;
      return payload && typeof payload === 'object' ? payload : null;
    } catch (error) {
      logDeduplicator.warn('PriorityFeesService: fills stats fetch failed', {
        hours,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async readHypeUsd(): Promise<number | null> {
    try {
      const raw = await redisService.get(PERP_MARKETS_CACHE_KEY);
      if (!raw) return null;
      const markets = JSON.parse(raw) as PerpMarketLite[];
      const hype = markets.find((m) => m?.name === 'HYPE');
      const px = hype ? Number(hype.price) : NaN;
      return Number.isFinite(px) && px > 0 ? px : null;
    } catch (error) {
      logDeduplicator.warn('PriorityFeesService: failed to read HYPE price', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
