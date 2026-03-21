import { BaseApiService } from '../../../core/base.api.service';
import {
  TopTradersApiResponse,
  TopTradersQueryParams,
  TopTradersSortType
} from '../../../types/toptraders.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { withDistributedLock } from '../../../utils/distributedLock';
import { logDeduplicator } from '../../../utils/logDeduplicator';

const CACHE_KEY_PREFIX = 'toptraders';
const UPDATE_CHANNEL = 'toptraders:updated';
const UPDATE_INTERVAL = 120000;
const CACHE_TTL = 55;
const SORT_TYPES: TopTradersSortType[] = ['pnl_pos', 'pnl_neg', 'volume', 'trades'];

/**
 * Client for HypeDexer Top Traders API
 * GET /overview/top-traders-24h
 * Follows Leaderboard/Hypurrscan standard with polling, Redis cache, and distributed lock
 */
export class HLIndexerTopTradersClient extends BaseApiService {
  private static instance: HLIndexerTopTradersClient;
  private static readonly API_URL = process.env.HL_INDEXER_API_URL || 'https://api-eu.hypedexer.com';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HLIndexerTopTradersClient.API_URL, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': HLIndexerTopTradersClient.API_KEY
    });

    this.circuitBreaker = CircuitBreakerService.getInstance('toptraders');
    this.rateLimiter = RateLimiterService.getInstance('toptraders', {
      maxWeightPerMinute: HLIndexerTopTradersClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerTopTradersClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HLIndexerTopTradersClient {
    if (!HLIndexerTopTradersClient.instance) {
      HLIndexerTopTradersClient.instance = new HLIndexerTopTradersClient();
    }
    return HLIndexerTopTradersClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Top Traders polling already started');
      return;
    }
    logDeduplicator.info('Starting Top Traders polling');
    this.updateTopTradersData().catch(err =>
      logDeduplicator.error('Error in initial Top Traders update:', { error: err instanceof Error ? err.message : String(err) })
    );
    this.pollingInterval = setInterval(() => {
      this.updateTopTradersData().catch(err =>
        logDeduplicator.error('Error in Top Traders polling:', { error: err instanceof Error ? err.message : String(err) })
      );
    }, UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Top Traders polling stopped');
    }
  }

  private async updateTopTradersData(): Promise<void> {
    const executed = await withDistributedLock('poll:toptraders', 90, async () => {
      for (const sort of SORT_TYPES) {
        try {
          const response = await this.fetchTopTraders(sort, 50);
          const key = `${CACHE_KEY_PREFIX}:${sort}`;
          await redisService.set(key, JSON.stringify(response), CACHE_TTL);
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          logDeduplicator.error(`Failed to fetch top traders for sort=${sort}`, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      await redisService.publish(UPDATE_CHANNEL, JSON.stringify({ type: 'DATA_UPDATED', timestamp: Date.now() }));
    });
    if (!executed) {
      logDeduplicator.info('Top Traders refresh skipped - another instance holds the lock');
    }
  }

  private async fetchTopTraders(sort: TopTradersSortType, limit: number): Promise<TopTradersApiResponse> {
    const queryString = `?sort=${sort}&limit=${limit}`;
    return this.circuitBreaker.execute(() =>
      this.get<TopTradersApiResponse>(`/overview/top-traders-24h${queryString}`)
    );
  }

  private buildQueryString(params: TopTradersQueryParams): string {
    const queryParams = new URLSearchParams();
    if (params.sort) queryParams.append('sort', params.sort);
    if (params.limit !== undefined) queryParams.append('limit', params.limit.toString());
    const qs = queryParams.toString();
    return qs ? `?${qs}` : '';
  }

  /**
   * Get top traders. Uses cache when limit<=50 and sort is cached; otherwise passthrough.
   */
  public async getTopTraders(params: TopTradersQueryParams = {}): Promise<TopTradersApiResponse> {
    const sort = params.sort || 'pnl_pos';
    const limit = params.limit ?? 50;

    if (limit > 50 || !SORT_TYPES.includes(sort)) {
      return this.fetchTopTraders(sort, limit);
    }

    const key = `${CACHE_KEY_PREFIX}:${sort}`;
    const cached = await redisService.get(key);
    if (cached) {
      const response: TopTradersApiResponse = JSON.parse(cached);
      if (limit < 50 && response.data.length > limit) {
        return { ...response, data: response.data.slice(0, limit) };
      }
      return response;
    }

    await this.updateTopTradersData();
    const reRead = await redisService.get(key);
    if (reRead) {
      const response: TopTradersApiResponse = JSON.parse(reRead);
      if (limit < 50 && response.data.length > limit) {
        return { ...response, data: response.data.slice(0, limit) };
      }
      return response;
    }

    return this.fetchTopTraders(sort, limit);
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HLIndexerTopTradersClient.REQUEST_WEIGHT;
  }
}
