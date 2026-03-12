import { HistoricalLiquidationRepository } from '../../repositories/interfaces/historical.repository.interface';
import { historicalLiquidationRepository } from '../../repositories';
import {
  HistoricalChartPeriod,
  HistoricalChartResult,
  ChartBucket,
  RawChartBucket,
} from '../../types/historical.types';
import { redisService } from '../../core/redis.service';
import { CACHE_KEYS } from '../../constants/cache.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';

interface ChartConfig {
  hours: number;
  bucketSizeMinutes: number;
  cacheTTL: number;
}

const CHART_CONFIG: Record<HistoricalChartPeriod, ChartConfig> = {
  '24h': { hours: 24,   bucketSizeMinutes: 30,  cacheTTL: 30 },
  '7d':  { hours: 168,  bucketSizeMinutes: 60,  cacheTTL: 60 },
  '14d': { hours: 336,  bucketSizeMinutes: 120, cacheTTL: 300 },
  '30d': { hours: 720,  bucketSizeMinutes: 240, cacheTTL: 300 },
  '90d': { hours: 2160, bucketSizeMinutes: 720, cacheTTL: 600 },
};

/**
 * Service for generating time-series chart data from the historical liquidation database.
 * Returns bucketed volume (total, long, short) for charting purposes.
 */
export class HistoricalChartService {
  private static instance: HistoricalChartService;
  private readonly repository: HistoricalLiquidationRepository;

  private constructor() {
    this.repository = historicalLiquidationRepository;
  }

  public static getInstance(): HistoricalChartService {
    if (!HistoricalChartService.instance) {
      HistoricalChartService.instance = new HistoricalChartService();
    }
    return HistoricalChartService.instance;
  }

  /**
   * Get time-bucketed chart data for a given period.
   * Buckets are auto-sized based on the period to keep point count ~48-180.
   * Empty buckets are filled with zeros to ensure a continuous series.
   * @param period Time window: '24h' | '7d' | '14d' | '30d' | '90d'
   * @param coin Optional coin filter (e.g. "BTC", "flx:SILVER")
   */
  async getChart(period: HistoricalChartPeriod = '7d', coin?: string): Promise<HistoricalChartResult> {
    const cacheKey = CACHE_KEYS.HISTORICAL_CHART(period, coin);

    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as HistoricalChartResult;
    }

    const config = CHART_CONFIG[period];
    const now = new Date();
    const since = new Date(now.getTime() - config.hours * 60 * 60 * 1000);

    const rawBuckets = await this.repository.getChart(since, config.bucketSizeMinutes, coin);
    const buckets = this.fillEmptyBuckets(rawBuckets, since, now, config.bucketSizeMinutes);

    const result: HistoricalChartResult = {
      buckets,
      filters: {
        period,
        coin: coin ?? null,
        bucketSizeMinutes: config.bucketSizeMinutes,
      },
      metadata: {
        computedAt: now.toISOString(),
        dataFrom: since.toISOString(),
        dataTo: now.toISOString(),
        totalBuckets: buckets.length,
        cacheTTL: config.cacheTTL,
      },
    };

    await redisService.set(cacheKey, JSON.stringify(result), config.cacheTTL);

    logDeduplicator.info('Historical chart computed', {
      period,
      coin,
      buckets: buckets.length,
      rawBuckets: rawBuckets.length,
    });

    return result;
  }

  /**
   * Generates a complete continuous bucket series and merges DB data into it.
   * Buckets with no liquidation events are filled with zeros.
   */
  private fillEmptyBuckets(
    raw: RawChartBucket[],
    since: Date,
    to: Date,
    bucketSizeMinutes: number
  ): ChartBucket[] {
    // Index DB results by their ISO timestamp for O(1) lookup
    const dbMap = new Map<string, RawChartBucket>();
    for (const row of raw) {
      dbMap.set(new Date(row.bucket).toISOString(), row);
    }

    const buckets: ChartBucket[] = [];
    const stepMs = bucketSizeMinutes * 60 * 1000;
    // Align cursor to the nearest bucket boundary at or before `since`
    let cursor = Math.floor(since.getTime() / stepMs) * stepMs;

    while (cursor < to.getTime()) {
      const ts = new Date(cursor).toISOString();
      const row = dbMap.get(ts);

      buckets.push({
        timestamp: ts,
        totalVolume_USD: row ? Math.round((row.total_volume ?? 0) * 100) / 100 : 0,
        count: row ? (row.total_count ?? 0) : 0,
        longVolume_USD: row ? Math.round((row.long_volume ?? 0) * 100) / 100 : 0,
        shortVolume_USD: row ? Math.round((row.short_volume ?? 0) * 100) / 100 : 0,
        longCount: row ? (row.long_count ?? 0) : 0,
        shortCount: row ? (row.short_count ?? 0) : 0,
      });

      cursor += stepMs;
    }

    return buckets;
  }
}
