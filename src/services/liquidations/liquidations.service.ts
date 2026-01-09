import { HLIndexerLiquidationsClient } from '../../clients/hlindexer/liquidations/liquidations.client';
import { 
  LiquidationResponse, 
  LiquidationQueryParams, 
  LiquidationsError,
  LiquidationStatsAllResponse,
  LiquidationStats,
  Liquidation
} from '../../types/liquidations.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';

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
  private static readonly STATS_CACHE_TTL = 60; // Cache stats for 60 seconds
  private static readonly RECENT_CACHE_TTL = 30; // Cache recent for 30 seconds

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
    const coinVolumes: Map<string, number> = new Map();

    for (const liq of liquidations) {
      // Total volume
      totalVolume += liq.notional_total;

      // Long/Short count
      if (liq.liq_dir === 'Long') {
        longCount++;
      } else {
        shortCount++;
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

    return {
      totalVolume: Math.round(totalVolume * 100) / 100,
      liquidationsCount: liquidations.length,
      longCount,
      shortCount,
      topCoin,
      topCoinVolume: Math.round(topCoinVolume * 100) / 100
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
      const now = Date.now();
      
      for (const hours of periods) {
        try {
          const cutoffTime = now - (hours * 60 * 60 * 1000);
          const periodData = allLiquidations.filter(liq => liq.time_ms >= cutoffTime);
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

  public checkRateLimit(ip: string): boolean {
    return this.client.checkRateLimit(ip);
  }
}

