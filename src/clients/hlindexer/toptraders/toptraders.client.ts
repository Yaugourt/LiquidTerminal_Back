import { BaseApiService } from '../../../core/base.api.service';
import {
  TopTradersApiResponse,
  TopTradersQueryParams,
  TopTradersError,
  TopTradersSortType
} from '../../../types/toptraders.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

/**
 * Client for HypeDexer Top Traders API
 * GET /overview/top-traders-24h
 * Follows the standard client architecture with CircuitBreaker and RateLimiter
 */
export class HLIndexerTopTradersClient extends BaseApiService {
  private static instance: HLIndexerTopTradersClient;
  private static readonly API_URL = process.env.HL_INDEXER_API_URL || 'https://api-eu.hypedexer.com';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

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

  /**
   * Build query string from params object
   */
  private buildQueryString(params: TopTradersQueryParams): string {
    const queryParams = new URLSearchParams();

    if (params.sort) {
      queryParams.append('sort', params.sort);
    }

    if (params.limit !== undefined) {
      queryParams.append('limit', params.limit.toString());
    }

    const queryString = queryParams.toString();
    return queryString ? `?${queryString}` : '';
  }

  /**
   * Get top traders for the last 24 hours
   * Supports sorting by pnl_pos, pnl_neg, volume, trades
   */
  public async getTopTraders(params: TopTradersQueryParams = {}): Promise<TopTradersApiResponse> {
    return this.circuitBreaker.execute(async () => {
      const queryString = this.buildQueryString({
        sort: params.sort || 'pnl_pos',
        limit: params.limit || 50
      });
      const endpoint = `/overview/top-traders-24h${queryString}`;

      logDeduplicator.info('Fetching top traders from HypeDexer', {
        endpoint,
        params
      });

      const response = await this.get<TopTradersApiResponse>(endpoint);

      logDeduplicator.info('Successfully fetched top traders', {
        count: response.data?.length || 0,
        executionTime: response.execution_time_ms
      });

      return response;
    });
  }

  /**
   * Check rate limit for an IP
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HLIndexerTopTradersClient.REQUEST_WEIGHT;
  }
}
