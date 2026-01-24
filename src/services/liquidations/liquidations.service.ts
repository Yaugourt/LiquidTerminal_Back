import { HLIndexerLiquidationsClient } from '../../clients/hlindexer/liquidations/liquidations.client';
import { 
  LiquidationResponse, 
  LiquidationQueryParams, 
  LiquidationsError,
  LiquidationStatsAllResponse,
  LiquidationStats,
  Liquidation,
  ChartDataBucket,
  ChartInterval,
  ChartPeriod,
  LiquidationChartDataResponse,
  LiquidationsDataResponse,
  PeriodData
} from '../../types/liquidations.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';

/**
 * Period configuration for chart data aggregation
 */
interface PeriodConfig {
  hours: number;
  interval: ChartInterval;
  intervalMs: number;
  useStatsCache: boolean;
  maxPages: number;
  cacheTTL: number;
}

/**
 * Service for liquidations business logic
 * Follows the Singleton pattern as per architecture
 * Returns original HypeDexer API format
 */
export class LiquidationsService {
  private static instance: LiquidationsService;
  private readonly client: HLIndexerLiquidationsClient;
  private static readonly DEFAULT_LIMIT = 100;
  private static readonly MAX_PAGES_FOR_STATS = 5; // Max 5 pages (5000 liquidations)
  
  // Cache TTLs - increased to reduce API calls
  private static readonly DATA_CACHE_TTL = 180; // 3 minutes for unified data
  private static readonly STATS_CACHE_TTL = 180; // 3 minutes for stats
  private static readonly RECENT_CACHE_TTL = 180; // 3 minutes for recent

  // Background refresh configuration
  private static readonly REFRESH_INTERVAL_MS = 300_000; // Refresh every 5 minutes (reduces API calls)
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;

  // Chart data configuration per period (max 24h)
  private static readonly PERIOD_CONFIG: Record<ChartPeriod, PeriodConfig> = {
    '2h':  { hours: 2,   interval: '5m',  intervalMs: 5 * 60 * 1000,   useStatsCache: true, maxPages: 5, cacheTTL: 180 },
    '4h':  { hours: 4,   interval: '5m',  intervalMs: 5 * 60 * 1000,   useStatsCache: true, maxPages: 5, cacheTTL: 180 },
    '8h':  { hours: 8,   interval: '15m', intervalMs: 15 * 60 * 1000,  useStatsCache: true, maxPages: 5, cacheTTL: 180 },
    '12h': { hours: 12,  interval: '15m', intervalMs: 15 * 60 * 1000,  useStatsCache: true, maxPages: 5, cacheTTL: 180 },
    '24h': { hours: 24,  interval: '30m', intervalMs: 30 * 60 * 1000,  useStatsCache: true, maxPages: 5, cacheTTL: 180 },
  };


  private constructor() {
    this.client = HLIndexerLiquidationsClient.getInstance();
  }

  public static getInstance(): LiquidationsService {
    if (!LiquidationsService.instance) {
      LiquidationsService.instance = new LiquidationsService();
    }
    return LiquidationsService.instance;
  }

  /**
   * Start background polling to refresh cache automatically
   * Should be called once at server startup
   */
  public startPolling(): void {
    if (this.refreshTimer) {
      logDeduplicator.warn('Liquidations polling already started');
      return;
    }

    logDeduplicator.info('Starting liquidations background polling', {
      intervalMs: LiquidationsService.REFRESH_INTERVAL_MS
    });

    // Initial refresh after 5 seconds (let server stabilize)
    setTimeout(() => {
      this.refreshAllData();
    }, 5000);

    // Then refresh every REFRESH_INTERVAL_MS
    this.refreshTimer = setInterval(() => {
      this.refreshAllData();
    }, LiquidationsService.REFRESH_INTERVAL_MS);
  }

  /**
   * Stop background polling
   */
  public stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      logDeduplicator.info('Liquidations background polling stopped');
    }
  }

  /**
   * Refresh all liquidation data in background
   * Called by polling timer - never throws, just logs errors
   */
  private async refreshAllData(): Promise<void> {
    if (this.isRefreshing) {
      logDeduplicator.info('Skipping refresh - already in progress');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      logDeduplicator.info('Background refresh: fetching liquidations data');

      // Fetch all liquidations once (24h, up to 5000)
      const allLiquidations: Liquidation[] = [];
      let cursor: string | null = null;
      let pagesLoaded = 0;
      let hasMore = true;

      while (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
        const response = await this.client.getRecentLiquidations({
          hours: 24,
          limit: 1000,
          order: 'DESC',
          cursor: cursor || undefined
        });

        allLiquidations.push(...response.data);
        cursor = response.next_cursor;
        hasMore = response.has_more;
        pagesLoaded++;

        // Delay between pages to avoid rate limiting
        if (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      logDeduplicator.info('Background refresh: liquidations fetched', {
        total: allLiquidations.length,
        pages: pagesLoaded
      });

      // Build and cache unified data for /liquidations/data endpoint
      await this.buildAndCacheUnifiedData(allLiquidations);

      // Also cache for /stats/all endpoint
      await this.buildAndCacheStatsAll(allLiquidations);

      const executionTimeMs = Date.now() - startTime;
      logDeduplicator.info('Background refresh completed successfully', {
        executionTimeMs,
        liquidationsCount: allLiquidations.length
      });
    } catch (error) {
      logDeduplicator.error('Background refresh failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Build and cache unified data (stats + chart) for all periods
   */
  private async buildAndCacheUnifiedData(allLiquidations: Liquidation[]): Promise<void> {
    const cacheKey = 'liquidations:all-data';
    const periods: ChartPeriod[] = ['2h', '4h', '8h', '12h', '24h'];
    const now = Date.now();
    const periodsData: Record<string, PeriodData> = {};

    for (const period of periods) {
      const config = LiquidationsService.PERIOD_CONFIG[period];
      const cutoffTime = now - (config.hours * 60 * 60 * 1000);
      
      const periodLiquidations = allLiquidations.filter(liq => {
        const liqTime = new Date(liq.time).getTime();
        return liqTime >= cutoffTime;
      });

      const stats = this.calculateStats(periodLiquidations);
      const buckets = this.aggregateIntoBuckets(periodLiquidations, config.intervalMs, config.hours);

      periodsData[period] = {
        stats,
        chart: { interval: config.interval, buckets }
      };
    }

    const result: LiquidationsDataResponse = {
      success: true,
      periods: periodsData as LiquidationsDataResponse['periods'],
      metadata: {
        executionTimeMs: 0,
        cachedAt: new Date().toISOString()
      }
    };

    await redisService.set(cacheKey, JSON.stringify(result), LiquidationsService.DATA_CACHE_TTL);
    logDeduplicator.info('Unified data cached', { cacheKey });
  }

  /**
   * Build and cache stats for /stats/all endpoint
   */
  private async buildAndCacheStatsAll(allLiquidations: Liquidation[]): Promise<void> {
    const cacheKey = 'liquidations:stats';
    const periods = [2, 4, 8, 12, 24] as const;
    const now = Date.now();
    const results: Record<string, LiquidationStats | null> = {};

    for (const hours of periods) {
      const cutoffTime = now - (hours * 60 * 60 * 1000);
      const periodLiquidations = allLiquidations.filter(liq => {
        const liqTime = new Date(liq.time).getTime();
        return liqTime >= cutoffTime;
      });

      results[`${hours}h`] = this.calculateStats(periodLiquidations);
    }

    const result: LiquidationStatsAllResponse = {
      success: true,
      stats: results as LiquidationStatsAllResponse['stats'],
      metadata: {
        executionTimeMs: 0,
        cachedAt: new Date().toISOString()
      }
    };

    await redisService.set(cacheKey, JSON.stringify(result), LiquidationsService.STATS_CACHE_TTL);
    logDeduplicator.info('Stats all cached', { cacheKey });
  }

  /**
   * Get cache key for recent liquidations
   */
  private getRecentCacheKey(hours: number, limit: number): string {
    return `liquidations:recent:${hours}h:${limit}`;
  }

  /**
   * Get historical liquidations with filters and keyset pagination
   * Returns original HypeDexer format
   */
  public async getLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    try {
      const limit = params.limit ?? LiquidationsService.DEFAULT_LIMIT;

      logDeduplicator.info('LiquidationsService.getLiquidations called', { params });
      
      const response = await this.client.getLiquidations({
        ...params,
        limit
      });

      logDeduplicator.info('LiquidationsService.getLiquidations completed', {
        count: response.data?.length || 0,
        hasMore: response.has_more
      });

      return response;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getLiquidations failed', { 
        error: error instanceof Error ? error.message : String(error),
        params 
      });
      
      if (error instanceof LiquidationsError) {
        throw error;
      }
      
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch liquidations',
        500,
        'LIQUIDATIONS_SERVICE_ERROR'
      );
    }
  }

  /**
   * Get recent liquidations with caching
   * Supports hours parameter for time-based filtering
   * Returns original HypeDexer format
   */
  public async getRecentLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    try {
      const limit = params.limit ?? LiquidationsService.DEFAULT_LIMIT;
      const hours = params.hours ?? 2;
      const cacheKey = this.getRecentCacheKey(hours, limit);

      // Check cache first
      try {
        const cached = await redisService.get(cacheKey);
        if (cached) {
          logDeduplicator.info('LiquidationsService.getRecentLiquidations cache hit', { hours, limit });
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        logDeduplicator.warn('Redis cache error, proceeding without cache', { error: String(cacheError) });
      }

      logDeduplicator.info('LiquidationsService.getRecentLiquidations called', { params });
      
      const response = await this.client.getRecentLiquidations({
        ...params,
        limit
      });

      // Cache the response
      try {
        await redisService.set(cacheKey, JSON.stringify(response), LiquidationsService.RECENT_CACHE_TTL);
      } catch (cacheError) {
        logDeduplicator.warn('Failed to cache recent liquidations', { error: String(cacheError) });
      }

      logDeduplicator.info('LiquidationsService.getRecentLiquidations completed', {
        count: response.data?.length || 0,
        hasMore: response.has_more
      });

      return response;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getRecentLiquidations failed', { 
        error: error instanceof Error ? error.message : String(error),
        params 
      });
      
      if (error instanceof LiquidationsError) {
        throw error;
      }
      
      // Return 429 for rate limit errors
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
  /**
   * Calculate aggregated stats from liquidation data
   */
  private calculateStats(liquidations: Liquidation[]) {
    let totalVolume = 0;
    let longCount = 0;
    let shortCount = 0;
    let longVolume = 0;
    let shortVolume = 0;
    let maxLiq = 0;
    const coinVolumes: Map<string, number> = new Map();

    for (const liq of liquidations) {
      // Total volume
      totalVolume += liq.notional_total;

      // Track max liquidation
      if (liq.notional_total > maxLiq) {
        maxLiq = liq.notional_total;
      }

      // Long/Short count and volume
      if (liq.liq_dir === 'Long') {
        longCount++;
        longVolume += liq.notional_total;
      } else {
        shortCount++;
        shortVolume += liq.notional_total;
      }

      // Coin volumes for top coin
      const currentVolume = coinVolumes.get(liq.coin) || 0;
      coinVolumes.set(liq.coin, currentVolume + liq.notional_total);
    }

    // Find top coin by volume
    let topCoin = 'N/A';
    let topCoinVolume = 0;
    for (const [coin, volume] of coinVolumes) {
      if (volume > topCoinVolume) {
        topCoin = coin;
        topCoinVolume = volume;
      }
    }

    // Calculate average size (avoid division by zero)
    const avgSize = liquidations.length > 0 
      ? Math.round((totalVolume / liquidations.length) * 100) / 100 
      : 0;

    return {
      totalVolume: Math.round(totalVolume * 100) / 100,
      liquidationsCount: liquidations.length,
      longCount,
      shortCount,
      topCoin,
      topCoinVolume: Math.round(topCoinVolume * 100) / 100,
      avgSize,
      maxLiq: Math.round(maxLiq * 100) / 100,
      longVolume: Math.round(longVolume * 100) / 100,
      shortVolume: Math.round(shortVolume * 100) / 100
    };
  }

  /**
   * Get stats for ALL periods (2h, 4h, 8h, 12h, 24h) in one call
   * Uses sequential fetching to avoid rate limiting
   * Returns partial results if some periods fail
   */
  public async getAllStats(): Promise<LiquidationStatsAllResponse> {
    const cacheKey = 'liquidations:stats:all';
    
    // Check cache first
    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        logDeduplicator.info('LiquidationsService.getAllStats cache hit');
        return JSON.parse(cached);
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error, proceeding without cache', { error: String(cacheError) });
    }

    const startTime = Date.now();
    const periods = [2, 4, 8, 12, 24] as const;
    const results: { [key: string]: LiquidationStats | null } = {
      '2h': null,
      '4h': null,
      '8h': null,
      '12h': null,
      '24h': null
    };
    const errors: string[] = [];

    logDeduplicator.info('LiquidationsService.getAllStats called');

    // Fetch 24h data first (largest period) and calculate all periods from it
    try {
      const allLiquidations: Liquidation[] = [];
      let cursor: string | null = null;
      let pagesLoaded = 0;
      let hasMore = true;

      // Fetch all pages for 24h
      while (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
        const response = await this.client.getRecentLiquidations({
          hours: 24,
          limit: 1000,
          order: 'DESC',
          cursor: cursor || undefined
        });

        allLiquidations.push(...response.data);
        cursor = response.next_cursor;
        hasMore = response.has_more;
        pagesLoaded++;

        logDeduplicator.info('Stats all - page loaded', {
          page: pagesLoaded,
          itemsInPage: response.data.length,
          totalSoFar: allLiquidations.length,
          hasMore
        });

        // Delay between pages to avoid rate limiting
        if (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // Calculate stats for each period by filtering the 24h data
      // NOTE: We use the 'time' field (ISO string) instead of 'time_ms' because
      // HypeDexer API sometimes returns corrupted time_ms values (in the future)
      const now = Date.now();
      
      for (const hours of periods) {
        try {
          const cutoffTime = now - (hours * 60 * 60 * 1000);
          const periodData = allLiquidations.filter(liq => {
            // Parse the ISO time string to get accurate timestamp
            const liqTime = new Date(liq.time).getTime();
            return liqTime >= cutoffTime;
          });
          results[`${hours}h`] = this.calculateStats(periodData);
          
          logDeduplicator.info(`Stats calculated for ${hours}h`, {
            count: periodData.length
          });
        } catch (periodError) {
          errors.push(`Failed to calculate ${hours}h stats`);
          logDeduplicator.error(`Failed to calculate ${hours}h stats`, { error: String(periodError) });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to fetch liquidation data: ${errorMessage}`);
      logDeduplicator.error('LiquidationsService.getAllStats failed to fetch data', { error: errorMessage });
    }

    const executionTimeMs = Date.now() - startTime;
    const cachedAt = new Date().toISOString();

    const result: LiquidationStatsAllResponse = {
      success: errors.length === 0 || Object.values(results).some(v => v !== null),
      stats: results as LiquidationStatsAllResponse['stats'],
      ...(errors.length > 0 && { errors }),
      metadata: {
        executionTimeMs,
        cachedAt
      }
    };

    // Cache the result
    try {
      await redisService.set(cacheKey, JSON.stringify(result), LiquidationsService.STATS_CACHE_TTL);
      logDeduplicator.info('Stats all cached successfully', { cacheKey });
    } catch (cacheError) {
      logDeduplicator.warn('Failed to cache stats all', { error: String(cacheError) });
    }

    logDeduplicator.info('LiquidationsService.getAllStats completed', {
      executionTimeMs,
      errorsCount: errors.length,
      periodsWithData: Object.values(results).filter(v => v !== null).length
    });

    return result;
  }

  /**
   * Get unified data (stats + chart) for ALL periods in one call
   * Combines /stats/all and /chart-data functionality
   * Reduces API calls by 67%
   */
  public async getAllData(): Promise<LiquidationsDataResponse> {
    const cacheKey = 'liquidations:all-data';
    
    // Check cache first
    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        logDeduplicator.info('LiquidationsService.getAllData cache hit');
        return JSON.parse(cached);
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error for all-data', { error: String(cacheError) });
    }

    const startTime = Date.now();
    const periods: ChartPeriod[] = ['2h', '4h', '8h', '12h', '24h'];

    logDeduplicator.info('LiquidationsService.getAllData called');

    try {
      // Fetch all liquidations once (24h, up to 5000)
      const allLiquidations: Liquidation[] = [];
      let cursor: string | null = null;
      let pagesLoaded = 0;
      let hasMore = true;

      while (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
        const response = await this.client.getRecentLiquidations({
          hours: 24,
          limit: 1000,
          order: 'DESC',
          cursor: cursor || undefined
        });

        allLiquidations.push(...response.data);
        cursor = response.next_cursor;
        hasMore = response.has_more;
        pagesLoaded++;

        if (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      logDeduplicator.info('All liquidations fetched for unified data', {
        total: allLiquidations.length,
        pages: pagesLoaded
      });

      // Build periods data
      const now = Date.now();
      const periodsData: Record<string, PeriodData> = {};

      for (const period of periods) {
        const config = LiquidationsService.PERIOD_CONFIG[period];
        const cutoffTime = now - (config.hours * 60 * 60 * 1000);
        
        // Filter liquidations for this period
        const periodLiquidations = allLiquidations.filter(liq => {
          const liqTime = new Date(liq.time).getTime();
          return liqTime >= cutoffTime;
        });

        // Calculate stats
        const stats = this.calculateStats(periodLiquidations);

        // Aggregate into buckets
        const buckets = this.aggregateIntoBuckets(periodLiquidations, config.intervalMs, config.hours);

        periodsData[period] = {
          stats,
          chart: {
            interval: config.interval,
            buckets
          }
        };
      }

      const executionTimeMs = Date.now() - startTime;
      const cachedAt = new Date().toISOString();

      const result: LiquidationsDataResponse = {
        success: true,
        periods: periodsData as LiquidationsDataResponse['periods'],
        metadata: {
          executionTimeMs,
          cachedAt
        }
      };

      // Cache the result
      try {
        await redisService.set(cacheKey, JSON.stringify(result), LiquidationsService.STATS_CACHE_TTL);
        logDeduplicator.info('All-data cached successfully', { cacheKey });
      } catch (cacheError) {
        logDeduplicator.warn('Failed to cache all-data', { error: String(cacheError) });
      }

      logDeduplicator.info('LiquidationsService.getAllData completed', {
        executionTimeMs,
        periods: periods.length
      });

      return result;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getAllData failed', { 
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Propagate rate limit errors with proper status code
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        throw new LiquidationsError(
          'API rate limit exceeded. Please try again in a few seconds.',
          429,
          'RATE_LIMIT_EXCEEDED'
        );
      }
      
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch unified liquidation data',
        500,
        'ALL_DATA_ERROR'
      );
    }
  }

  /**
   * Get chart data for a specific period with aggregated buckets
   * Uses stats cache for periods <=24h, historical fetch for longer periods
   */
  public async getChartData(period: ChartPeriod): Promise<LiquidationChartDataResponse> {
    const config = LiquidationsService.PERIOD_CONFIG[period];
    const cacheKey = `liquidations:chart:${period}`;
    const startTime = Date.now();

    // Check cache first
    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        logDeduplicator.info('LiquidationsService.getChartData cache hit', { period });
        return JSON.parse(cached);
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error for chart data', { error: String(cacheError) });
    }

    logDeduplicator.info('LiquidationsService.getChartData called', { period, config });

    let liquidations: Liquidation[];
    let dataSource: 'stats-cache' | 'historical-fetch';

    try {
      if (config.useStatsCache) {
        // For periods <=24h, reuse the stats cache data
        liquidations = await this.getLiquidationsFromStatsCache(config.hours);
        dataSource = 'stats-cache';
      } else {
        // For longer periods (7d, 30d), fetch from historical endpoint
        liquidations = await this.fetchHistoricalLiquidations(config.hours, config.maxPages);
        dataSource = 'historical-fetch';
      }

      // Aggregate into buckets
      const buckets = this.aggregateIntoBuckets(liquidations, config.intervalMs, config.hours);

      // Calculate totals
      let totalVolume = 0;
      for (const bucket of buckets) {
        totalVolume += bucket.totalVolume;
      }

      const executionTimeMs = Date.now() - startTime;
      const cachedAt = new Date().toISOString();

      const result: LiquidationChartDataResponse = {
        success: true,
        period,
        interval: config.interval,
        buckets,
        metadata: {
          bucketCount: buckets.length,
          totalLiquidations: liquidations.length,
          totalVolume: Math.round(totalVolume * 100) / 100,
          executionTimeMs,
          cachedAt,
          dataSource
        }
      };

      // Cache the result
      try {
        await redisService.set(cacheKey, JSON.stringify(result), config.cacheTTL);
        logDeduplicator.info('Chart data cached successfully', { cacheKey, period });
      } catch (cacheError) {
        logDeduplicator.warn('Failed to cache chart data', { error: String(cacheError) });
      }

      logDeduplicator.info('LiquidationsService.getChartData completed', {
        period,
        bucketCount: buckets.length,
        totalLiquidations: liquidations.length,
        executionTimeMs
      });

      return result;
    } catch (error) {
      logDeduplicator.error('LiquidationsService.getChartData failed', { 
        error: error instanceof Error ? error.message : String(error),
        period 
      });
      
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch chart data',
        500,
        'CHART_DATA_ERROR'
      );
    }
  }

  /**
   * Get liquidations from the stats cache (reuse getAllStats data)
   * Fetches up to 5 pages (5000 liquidations) for 24h
   */
  private async getLiquidationsFromStatsCache(hours: number): Promise<Liquidation[]> {
    const allLiquidations: Liquidation[] = [];
    let cursor: string | null = null;
    let pagesLoaded = 0;
    let hasMore = true;

    while (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
      const response = await this.client.getRecentLiquidations({
        hours: 24, // Always fetch 24h, we'll filter later
        limit: 1000,
        order: 'DESC',
        cursor: cursor || undefined
      });

      allLiquidations.push(...response.data);
      cursor = response.next_cursor;
      hasMore = response.has_more;
      pagesLoaded++;

      if (hasMore && pagesLoaded < LiquidationsService.MAX_PAGES_FOR_STATS) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Filter by hours if less than 24h
    if (hours < 24) {
      const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
      return allLiquidations.filter(liq => {
        const liqTime = new Date(liq.time).getTime();
        return liqTime >= cutoffTime;
      });
    }

    return allLiquidations;
  }

  /**
   * Fetch historical liquidations for longer periods (7d, 30d)
   * Uses the /liquidations endpoint with start_time
   */
  private async fetchHistoricalLiquidations(hours: number, maxPages: number): Promise<Liquidation[]> {
    const allLiquidations: Liquidation[] = [];
    let cursor: string | null = null;
    let pagesLoaded = 0;
    let hasMore = true;

    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    logDeduplicator.info('Fetching historical liquidations', { hours, startTime, maxPages });

    while (hasMore && pagesLoaded < maxPages) {
      const response = await this.client.getLiquidations({
        start_time: startTime,
        limit: 1000,
        order: 'DESC',
        cursor: cursor || undefined
      });

      allLiquidations.push(...response.data);
      cursor = response.next_cursor;
      hasMore = response.has_more;
      pagesLoaded++;

      logDeduplicator.info('Historical fetch - page loaded', {
        page: pagesLoaded,
        itemsInPage: response.data.length,
        totalSoFar: allLiquidations.length,
        hasMore
      });

      // Delay between pages to avoid rate limiting
      if (hasMore && pagesLoaded < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    return allLiquidations;
  }

  /**
   * Aggregate liquidations into time buckets
   */
  private aggregateIntoBuckets(liquidations: Liquidation[], intervalMs: number, hours: number): ChartDataBucket[] {
    const now = Date.now();
    const startMs = now - (hours * 60 * 60 * 1000);
    
    // Calculate number of buckets
    const numBuckets = Math.ceil((hours * 60 * 60 * 1000) / intervalMs);
    
    // Initialize buckets
    const buckets: Map<number, ChartDataBucket> = new Map();
    
    for (let i = 0; i < numBuckets; i++) {
      const bucketStart = startMs + (i * intervalMs);
      buckets.set(bucketStart, {
        timestamp: new Date(bucketStart).toISOString(),
        timestampMs: bucketStart,
        totalVolume: 0,
        longVolume: 0,
        shortVolume: 0,
        liquidationsCount: 0,
        longCount: 0,
        shortCount: 0
      });
    }

    // Aggregate liquidations into buckets
    for (const liq of liquidations) {
      const liqTime = new Date(liq.time).getTime();
      
      // Find the bucket this liquidation belongs to
      const bucketIndex = Math.floor((liqTime - startMs) / intervalMs);
      const bucketStart = startMs + (bucketIndex * intervalMs);
      
      const bucket = buckets.get(bucketStart);
      if (bucket) {
        bucket.totalVolume += liq.notional_total;
        bucket.liquidationsCount++;
        
        if (liq.liq_dir === 'Long') {
          bucket.longVolume += liq.notional_total;
          bucket.longCount++;
        } else {
          bucket.shortVolume += liq.notional_total;
          bucket.shortCount++;
        }
      }
    }

    // Convert to array and round values
    const result: ChartDataBucket[] = [];
    for (const bucket of buckets.values()) {
      result.push({
        ...bucket,
        totalVolume: Math.round(bucket.totalVolume * 100) / 100,
        longVolume: Math.round(bucket.longVolume * 100) / 100,
        shortVolume: Math.round(bucket.shortVolume * 100) / 100
      });
    }

    // Sort by timestamp ascending
    result.sort((a, b) => a.timestampMs - b.timestampMs);

    return result;
  }

  public checkRateLimit(ip: string): boolean {
    return this.client.checkRateLimit(ip);
  }
}

