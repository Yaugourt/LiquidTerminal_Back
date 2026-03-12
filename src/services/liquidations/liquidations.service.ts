import { HLIndexerLiquidationsClient } from '../../clients/hlindexer/liquidations/liquidations.client';
import {
  LiquidationResponse,
  LiquidationQueryParams,
  LiquidationsError,
  LiquidationStatsAllResponse,
  LiquidationStats,
  ChartDataBucket,
  ChartInterval,
  ChartPeriod,
  LiquidationChartDataResponse,
  LiquidationsDataResponse,
  PeriodData
} from '../../types/liquidations.types';
import { AnalyticsLiquidationStatsResponse } from '../../types/analytics-liquidations.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';
import { SSEManagerService } from './sse-manager.service';
import { LiquidationDataProvider } from '../../types/liquidation-provider.interface';
import { historicalLiquidationRepository } from '../../repositories';
import { HistoricalStats, RawChartBucket } from '../../types/historical.types';

interface PeriodConfig {
  hours: number;
  interval: ChartInterval;
  bucketSizeMinutes: number;
}

/**
 * Service for liquidations business logic.
 * Stats/chart data is served from the historical DB (fed by WS ingestion).
 * REST API passthrough kept for getLiquidations/getRecentLiquidations/analytics.
 */
export class LiquidationsService implements LiquidationDataProvider {
  private static instance: LiquidationsService;
  private readonly client: HLIndexerLiquidationsClient;
  private static readonly DEFAULT_LIMIT = 100;
  
  private static readonly DATA_CACHE_TTL = 15;
  private static readonly STATS_CACHE_TTL = 15;
  private static readonly RECENT_CACHE_TTL = 15;

  private static readonly PERIOD_CONFIG: Record<ChartPeriod, PeriodConfig> = {
    '2h':  { hours: 2,  interval: '5m',  bucketSizeMinutes: 5 },
    '4h':  { hours: 4,  interval: '5m',  bucketSizeMinutes: 5 },
    '8h':  { hours: 8,  interval: '15m', bucketSizeMinutes: 15 },
    '12h': { hours: 12, interval: '15m', bucketSizeMinutes: 15 },
    '24h': { hours: 24, interval: '30m', bucketSizeMinutes: 30 },
  };

  private readonly sseManager: SSEManagerService;

  private constructor() {
    this.client = HLIndexerLiquidationsClient.getInstance();
    this.sseManager = SSEManagerService.getInstance();
    this.sseManager.setDataProvider(this);
  }

  public static getInstance(): LiquidationsService {
    if (!LiquidationsService.instance) {
      LiquidationsService.instance = new LiquidationsService();
    }
    return LiquidationsService.instance;
  }

  // ============================================================================
  // POLLING — disabled, data served from historical DB
  // ============================================================================

  public startPolling(): void {
    logDeduplicator.info('LiquidationsService: polling disabled (data served from historical DB)');
  }

  public stopPolling(): void {
    // no-op
  }

  // ============================================================================
  // UNIFIED DATA — /data endpoint (stats + chart for all periods)
  // ============================================================================

  public async getAllData(): Promise<LiquidationsDataResponse> {
    const cacheKey = 'liquidations:all-data';

    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error for all-data', { error: String(cacheError) });
    }

    const startTime = Date.now();
    const periods: ChartPeriod[] = ['2h', '4h', '8h', '12h', '24h'];
    const periodsData: Record<string, PeriodData> = {};

    try {
      await Promise.all(periods.map(async (period) => {
      const config = LiquidationsService.PERIOD_CONFIG[period];
        const since = new Date(Date.now() - config.hours * 60 * 60 * 1000);

        const [historicalStats, rawBuckets] = await Promise.all([
          historicalLiquidationRepository.getStats(since),
          historicalLiquidationRepository.getChart(since, config.bucketSizeMinutes),
        ]);

        const stats = this.convertHistoricalStats(historicalStats);
        const buckets = this.convertChartBuckets(rawBuckets, since, new Date(), config.bucketSizeMinutes);

      periodsData[period] = {
        stats,
          chart: { interval: config.interval, buckets },
      };
      }));

    const result: LiquidationsDataResponse = {
      success: true,
      periods: periodsData as LiquidationsDataResponse['periods'],
      metadata: {
          executionTimeMs: Date.now() - startTime,
          cachedAt: new Date().toISOString(),
        },
      };

      try {
        await redisService.set(cacheKey, JSON.stringify(result), LiquidationsService.DATA_CACHE_TTL);
      } catch (cacheError) {
        logDeduplicator.warn('Failed to cache all-data', { error: String(cacheError) });
      }

      return result;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getAllData failed', {
        error: error instanceof Error ? error.message : String(error),
      });
        throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch unified liquidation data',
        500,
        'ALL_DATA_ERROR'
      );
    }
  }

  // ============================================================================
  // STATS ALL — /stats/all endpoint
  // ============================================================================

  public async getAllStats(): Promise<LiquidationStatsAllResponse> {
    const cacheKey = 'liquidations:stats:all';
    
    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error for stats all', { error: String(cacheError) });
    }

    const startTime = Date.now();
    const periods = [2, 4, 8, 12, 24] as const;
    const results: Record<string, LiquidationStats | null> = {
      '2h': null, '4h': null, '8h': null, '12h': null, '24h': null,
    };
    const errors: string[] = [];

    try {
      await Promise.all(periods.map(async (hours) => {
        try {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const historicalStats = await historicalLiquidationRepository.getStats(since);
          results[`${hours}h`] = this.convertHistoricalStats(historicalStats);
        } catch (periodError) {
          errors.push(`Failed to calculate ${hours}h stats`);
          logDeduplicator.error(`Failed to calculate ${hours}h stats`, { error: String(periodError) });
        }
      }));
    } catch (error) {
      errors.push(`Failed to fetch stats: ${error instanceof Error ? error.message : String(error)}`);
    }

    const result: LiquidationStatsAllResponse = {
      success: errors.length === 0 || Object.values(results).some(v => v !== null),
      stats: results as LiquidationStatsAllResponse['stats'],
      ...(errors.length > 0 && { errors }),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        cachedAt: new Date().toISOString(),
      },
    };

    try {
      await redisService.set(cacheKey, JSON.stringify(result), LiquidationsService.STATS_CACHE_TTL);
    } catch (cacheError) {
      logDeduplicator.warn('Failed to cache stats all', { error: String(cacheError) });
    }

    return result;
  }

  // ============================================================================
  // CHART DATA — /chart-data endpoint
  // ============================================================================

  public async getChartData(period: ChartPeriod): Promise<LiquidationChartDataResponse> {
    const config = LiquidationsService.PERIOD_CONFIG[period];
    const cacheKey = `liquidations:chart:${period}`;
    const startTime = Date.now();

    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error for chart data', { error: String(cacheError) });
    }

    try {
      const now = new Date();
      const since = new Date(now.getTime() - config.hours * 60 * 60 * 1000);

      const rawBuckets = await historicalLiquidationRepository.getChart(since, config.bucketSizeMinutes);
      const buckets = this.convertChartBuckets(rawBuckets, since, now, config.bucketSizeMinutes);

      let totalVolume = 0;
      let totalLiquidations = 0;
      for (const bucket of buckets) {
        totalVolume += bucket.totalVolume;
        totalLiquidations += bucket.liquidationsCount;
      }

      const result: LiquidationChartDataResponse = {
        success: true,
        period,
        interval: config.interval,
        buckets,
        metadata: {
          bucketCount: buckets.length,
          totalLiquidations,
          totalVolume: Math.round(totalVolume * 100) / 100,
          executionTimeMs: Date.now() - startTime,
          cachedAt: new Date().toISOString(),
          dataSource: 'historical-fetch',
        },
      };

      try {
        await redisService.set(cacheKey, JSON.stringify(result), LiquidationsService.DATA_CACHE_TTL);
      } catch (cacheError) {
        logDeduplicator.warn('Failed to cache chart data', { error: String(cacheError) });
      }

      return result;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getChartData failed', { 
        error: error instanceof Error ? error.message : String(error),
        period,
      });
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch chart data',
        500,
        'CHART_DATA_ERROR'
      );
    }
  }

  // ============================================================================
  // REST API PASSTHROUGH — kept as-is
  // ============================================================================

  public async getLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    try {
      const limit = params.limit ?? LiquidationsService.DEFAULT_LIMIT;
      const response = await this.client.getLiquidations({ ...params, limit });
      return response;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getLiquidations failed', {
        error: error instanceof Error ? error.message : String(error),
        params,
      });
      if (error instanceof LiquidationsError) throw error;
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch liquidations',
        500,
        'LIQUIDATIONS_SERVICE_ERROR'
      );
    }
  }

  public async getRecentLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    try {
      const limit = params.limit ?? LiquidationsService.DEFAULT_LIMIT;
      const hours = params.hours ?? 2;
      const cacheKey = `liquidations:recent:${hours}h:${limit}`;

      try {
        const cached = await redisService.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (cacheError) {
        logDeduplicator.warn('Redis cache error, proceeding without cache', { error: String(cacheError) });
      }

      const response = await this.client.getRecentLiquidations({ ...params, limit });

      try {
        await redisService.set(cacheKey, JSON.stringify(response), LiquidationsService.RECENT_CACHE_TTL);
      } catch (cacheError) {
        logDeduplicator.warn('Failed to cache recent liquidations', { error: String(cacheError) });
      }

      return response;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getRecentLiquidations failed', {
        error: error instanceof Error ? error.message : String(error),
        params,
      });
      if (error instanceof LiquidationsError) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        throw new LiquidationsError(
          'API rate limit exceeded. Please try again in a few seconds.',
          429,
          'RATE_LIMIT_EXCEEDED'
        );
      }

      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch recent liquidations',
        500,
        'RECENT_LIQUIDATIONS_SERVICE_ERROR'
      );
    }
  }

  // ============================================================================
  // ANALYTICS — passthrough to HypeDexer analytics API
  // ============================================================================

  public async getAnalyticsStats(days: number = 1, coin?: string): Promise<AnalyticsLiquidationStatsResponse> {
    const cacheKey = `liquidations:analytics:${days}d${coin ? `:${coin.toUpperCase()}` : ''}`;

    try {
      const cached = await redisService.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error for analytics stats', { error: String(cacheError) });
    }

    try {
      const response = await this.client.getAnalyticsStats({ days, coin });

      try {
        await redisService.set(cacheKey, JSON.stringify(response), LiquidationsService.STATS_CACHE_TTL);
      } catch (cacheError) {
        logDeduplicator.warn('Failed to cache analytics stats', { error: String(cacheError) });
      }

      return response;
    } catch (error) {
      logDeduplicator.error('Failed to fetch analytics stats', {
        days, coin,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch analytics stats',
        500,
        'ANALYTICS_STATS_ERROR'
      );
    }
  }

  public async getAnalyticsStats24h(): Promise<AnalyticsLiquidationStatsResponse> {
    return this.getAnalyticsStats(1);
  }

  public checkRateLimit(ip: string): boolean {
    return this.client.checkRateLimit(ip);
  }

  // ============================================================================
  // PRIVATE — format converters
  // ============================================================================

  /**
   * Convert HistoricalStats (DB format) → LiquidationStats (API format)
   */
  private convertHistoricalStats(h: HistoricalStats): LiquidationStats {
    return {
      totalVolume: Math.round(h.totalVolume_USD * 100) / 100,
      liquidationsCount: h.liquidationsCount,
      longCount: h.longCount,
      shortCount: h.shortCount,
      topCoin: h.topCoin,
      topCoinVolume: Math.round(h.topCoinVolume_USD * 100) / 100,
      avgSize: Math.round(h.avgSize_USD * 100) / 100,
      maxLiq: Math.round(h.maxLiq_USD * 100) / 100,
      longVolume: Math.round(h.longVolume_USD * 100) / 100,
      shortVolume: Math.round(h.shortVolume_USD * 100) / 100,
    };
  }

  /**
   * Convert raw DB chart buckets → ChartDataBucket[] with zero-filled gaps
   */
  private convertChartBuckets(
    raw: RawChartBucket[],
    since: Date,
    to: Date,
    bucketSizeMinutes: number
  ): ChartDataBucket[] {
    const dbMap = new Map<string, RawChartBucket>();
    for (const row of raw) {
      dbMap.set(new Date(row.bucket).toISOString(), row);
    }

    const buckets: ChartDataBucket[] = [];
    const stepMs = bucketSizeMinutes * 60 * 1000;
    let cursor = Math.floor(since.getTime() / stepMs) * stepMs;

    while (cursor < to.getTime()) {
      const ts = new Date(cursor).toISOString();
      const row = dbMap.get(ts);

      buckets.push({
        timestamp: ts,
        timestampMs: cursor,
        totalVolume: row ? Math.round((row.total_volume ?? 0) * 100) / 100 : 0,
        longVolume: row ? Math.round((row.long_volume ?? 0) * 100) / 100 : 0,
        shortVolume: row ? Math.round((row.short_volume ?? 0) * 100) / 100 : 0,
        liquidationsCount: row ? (row.total_count ?? 0) : 0,
        longCount: row ? (row.long_count ?? 0) : 0,
        shortCount: row ? (row.short_count ?? 0) : 0,
      });

      cursor += stepMs;
    }

    return buckets;
  }
}
