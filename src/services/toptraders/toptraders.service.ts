import { HLIndexerTopTradersClient } from '../../clients/hlindexer/toptraders/toptraders.client';
import {
  TopTradersResponse,
  TopTradersQueryParams,
  TopTradersError,
  TopTrader,
  TopTradersSortType
} from '../../types/toptraders.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';

/**
 * Service for Top Traders business logic
 * Follows the Singleton pattern as per architecture
 * Background polling every 60 seconds
 */
export class TopTradersService {
  private static instance: TopTradersService;
  private readonly client: HLIndexerTopTradersClient;

  // Cache configuration
  private static readonly CACHE_TTL = 55; // Just under 60s polling interval
  private static readonly CACHE_KEY_PREFIX = 'toptraders';

  // Background refresh configuration - 60 seconds
  private static readonly REFRESH_INTERVAL_MS = 60_000;
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;

  // All sort types to pre-fetch
  private static readonly SORT_TYPES: TopTradersSortType[] = ['pnl_pos', 'pnl_neg', 'volume', 'trades'];

  private constructor() {
    this.client = HLIndexerTopTradersClient.getInstance();
  }

  public static getInstance(): TopTradersService {
    if (!TopTradersService.instance) {
      TopTradersService.instance = new TopTradersService();
    }
    return TopTradersService.instance;
  }

  /**
   * Get cache key for a specific sort type
   */
  private getCacheKey(sort: TopTradersSortType): string {
    return `${TopTradersService.CACHE_KEY_PREFIX}:${sort}`;
  }

  /**
   * Start background polling to refresh cache automatically
   * Should be called once at server startup
   */
  public startPolling(): void {
    if (this.refreshTimer) {
      logDeduplicator.warn('Top Traders polling already started');
      return;
    }

    logDeduplicator.info('Starting Top Traders background polling', {
      intervalMs: TopTradersService.REFRESH_INTERVAL_MS
    });

    // Initial refresh after 5 seconds (let server stabilize)
    setTimeout(() => {
      this.refreshAllData();
    }, 5000);

    // Then refresh every REFRESH_INTERVAL_MS (60 seconds)
    this.refreshTimer = setInterval(() => {
      this.refreshAllData();
    }, TopTradersService.REFRESH_INTERVAL_MS);
  }

  /**
   * Stop background polling
   */
  public stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      logDeduplicator.info('Top Traders background polling stopped');
    }
  }

  /**
   * Refresh all top traders data in background
   * Fetches all sort types and caches them
   * Called by polling timer - never throws, just logs errors
   */
  private async refreshAllData(): Promise<void> {
    if (this.isRefreshing) {
      logDeduplicator.info('Skipping Top Traders refresh - already in progress');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      logDeduplicator.info('Background refresh: fetching top traders data');

      // Fetch all sort types sequentially to avoid rate limiting
      for (const sort of TopTradersService.SORT_TYPES) {
        try {
          const response = await this.client.getTopTraders({
            sort,
            limit: 50
          });

          const cacheKey = this.getCacheKey(sort);
          const cacheData: TopTradersResponse = {
            success: true,
            data: response.data,
            metadata: {
              sort,
              limit: 50,
              executionTimeMs: response.execution_time_ms,
              cachedAt: new Date().toISOString()
            }
          };

          await redisService.set(cacheKey, JSON.stringify(cacheData), TopTradersService.CACHE_TTL);

          logDeduplicator.info(`Top Traders cached for sort=${sort}`, {
            count: response.data?.length || 0
          });

          // Small delay between requests to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          logDeduplicator.error(`Failed to fetch top traders for sort=${sort}`, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      const executionTimeMs = Date.now() - startTime;
      logDeduplicator.info('Top Traders background refresh completed', {
        executionTimeMs,
        sortTypes: TopTradersService.SORT_TYPES.length
      });
    } catch (error) {
      logDeduplicator.error('Top Traders background refresh failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get top traders with optional filters
   * Returns cached data if available, otherwise fetches from API
   */
  public async getTopTraders(params: TopTradersQueryParams = {}): Promise<TopTradersResponse> {
    const sort = params.sort || 'pnl_pos';
    const limit = params.limit || 50;
    const cacheKey = this.getCacheKey(sort);

    try {
      // Check cache first
      const cached = await redisService.get(cacheKey);
      if (cached) {
        logDeduplicator.info('TopTradersService.getTopTraders cache hit', { sort, limit });
        const cachedResponse: TopTradersResponse = JSON.parse(cached);

        // Apply limit if different from cached
        if (limit < 50 && cachedResponse.data.length > limit) {
          return {
            ...cachedResponse,
            data: cachedResponse.data.slice(0, limit),
            metadata: {
              ...cachedResponse.metadata,
              limit
            }
          };
        }

        return cachedResponse;
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error, proceeding without cache', { error: String(cacheError) });
    }

    // Cache miss - fetch from API
    logDeduplicator.info('TopTradersService.getTopTraders cache miss, fetching from API', { sort, limit });

    try {
      const response = await this.client.getTopTraders({ sort, limit });

      const result: TopTradersResponse = {
        success: true,
        data: response.data,
        metadata: {
          sort,
          limit,
          executionTimeMs: response.execution_time_ms,
          cachedAt: new Date().toISOString()
        }
      };

      // Cache the response if limit is 50 (full data)
      if (limit === 50) {
        try {
          await redisService.set(cacheKey, JSON.stringify(result), TopTradersService.CACHE_TTL);
        } catch (cacheError) {
          logDeduplicator.warn('Failed to cache top traders', { error: String(cacheError) });
        }
      }

      return result;
    } catch (error) {
      logDeduplicator.error('TopTradersService.getTopTraders failed', {
        error: error instanceof Error ? error.message : String(error),
        params
      });

      // Return 429 for rate limit errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        throw new TopTradersError(
          'API rate limit exceeded. Please try again in a few seconds.',
          429,
          'RATE_LIMIT_EXCEEDED'
        );
      }

      throw new TopTradersError(
        error instanceof Error ? error.message : 'Failed to fetch top traders',
        500,
        'TOP_TRADERS_SERVICE_ERROR'
      );
    }
  }

  /**
   * Check rate limit for an IP
   */
  public checkRateLimit(ip: string): boolean {
    return this.client.checkRateLimit(ip);
  }
}
