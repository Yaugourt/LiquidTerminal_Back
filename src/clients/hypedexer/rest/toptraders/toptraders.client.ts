import {
  TopTrader,
  TopTradersApiResponse,
  TopTradersQueryParams,
  TopTradersSortType,
} from '../../../../types/toptraders.types';
import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../../core/redis.service';
import { withDistributedLock } from '../../../../utils/distributedLock';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { coerceHypedexerListApiResponse } from '../../../../utils/hypedexer-api-response.util';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

const CACHE_KEY_PREFIX = 'toptraders';
const UPDATE_CHANNEL = 'toptraders:updated';
const UPDATE_INTERVAL = 120000;
const CACHE_TTL = 55;
const SORT_TYPES: TopTradersSortType[] = ['pnl_pos', 'pnl_neg', 'volume', 'trades'];

/**
 * Client for HypeDexer Top Traders API
 * GET /overview/top-traders-24h
 * Circuit breaker / rate limiter IDs: `toptraders`.
 */
export class HLIndexerTopTradersClient extends HypeDexerBaseClient {
  private static instance: HLIndexerTopTradersClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private pollingTimeout: NodeJS.Timeout | null = null;
  private pollingStopped = true;
  private consecutiveFailures = 0;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);

    this.circuitBreaker = CircuitBreakerService.getInstance('toptraders');
    this.rateLimiter = RateLimiterService.getInstance('toptraders', {
      maxWeightPerMinute: HLIndexerTopTradersClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerTopTradersClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HLIndexerTopTradersClient {
    if (!HLIndexerTopTradersClient.instance) {
      HLIndexerTopTradersClient.instance = new HLIndexerTopTradersClient();
    }
    return HLIndexerTopTradersClient.instance;
  }

  public startPolling(): void {
    if (!this.pollingStopped) {
      logDeduplicator.warn('Top Traders polling already started');
      return;
    }
    this.pollingStopped = false;
    logDeduplicator.info('Starting Top Traders polling');
    void this.tickTopTradersPolling();
  }

  public stopPolling(): void {
    this.pollingStopped = true;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
      logDeduplicator.info('Top Traders polling stopped');
    }
  }

  private async tickTopTradersPolling(): Promise<void> {
    if (this.pollingStopped) return;
    try {
      await this.updateTopTradersData();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      logDeduplicator.error('Error in Top Traders polling:', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });
    }
    if (this.pollingStopped) return;
    const multiplier = Math.min(Math.pow(2, this.consecutiveFailures), 10);
    const delay = UPDATE_INTERVAL * multiplier;
    this.pollingTimeout = setTimeout(() => {
      void this.tickTopTradersPolling();
    }, delay);
  }

  private async updateTopTradersData(): Promise<void> {
    let allRejected = false;
    const executed = await withDistributedLock('poll:toptraders', 90, async () => {
      const results = await Promise.allSettled(
        SORT_TYPES.map(async (sort) => {
          const response = await this.fetchTopTraders(sort, 50);
          const key = `${CACHE_KEY_PREFIX}:${sort}`;
          await redisService.set(key, JSON.stringify(response), CACHE_TTL);
          return sort;
        })
      );
      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          const sort = SORT_TYPES[idx];
          logDeduplicator.error(`Failed to fetch top traders for sort=${sort}`, {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
      await redisService.publish(UPDATE_CHANNEL, JSON.stringify({ type: 'DATA_UPDATED', timestamp: Date.now() }));
      allRejected = results.every((r) => r.status === 'rejected');
    });
    if (!executed) {
      logDeduplicator.info('Top Traders refresh skipped - another instance holds the lock');
      return;
    }
    if (allRejected) {
      throw new Error('All top traders fetches failed');
    }
  }

  private async fetchTopTraders(sort: TopTradersSortType, limit: number): Promise<TopTradersApiResponse> {
    const queryString = `?sort=${sort}&limit=${limit}`;
    return this.circuitBreaker.execute(async () => {
      const raw = await this.getUnwrapped<unknown>(`/overview/top-traders-24h${queryString}`);
      return coerceHypedexerListApiResponse<TopTrader>(raw) as TopTradersApiResponse;
    });
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

    try {
      await this.updateTopTradersData();
    } catch (err) {
      logDeduplicator.warn('On-demand top traders refresh failed; falling back to passthrough', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
