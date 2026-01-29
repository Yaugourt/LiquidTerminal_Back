import { BaseApiService } from '../../../core/base.api.service';
import {
  ActiveUsersApiResponse,
  ActiveUsersQueryParams,
  ActiveUsersError
} from '../../../types/activeusers.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

/**
 * Client for HypeDexer Active Users API
 * GET /users/active
 * Follows the standard client architecture with CircuitBreaker and RateLimiter
 */
export class HLIndexerActiveUsersClient extends BaseApiService {
  private static instance: HLIndexerActiveUsersClient;
  private static readonly API_URL = process.env.HL_INDEXER_API_URL || 'https://api-eu.hypedexer.com';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HLIndexerActiveUsersClient.API_URL, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': HLIndexerActiveUsersClient.API_KEY
    });

    this.circuitBreaker = CircuitBreakerService.getInstance('activeusers');
    this.rateLimiter = RateLimiterService.getInstance('activeusers', {
      maxWeightPerMinute: HLIndexerActiveUsersClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerActiveUsersClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HLIndexerActiveUsersClient {
    if (!HLIndexerActiveUsersClient.instance) {
      HLIndexerActiveUsersClient.instance = new HLIndexerActiveUsersClient();
    }
    return HLIndexerActiveUsersClient.instance;
  }

  /**
   * Build query string from params object
   */
  private buildQueryString(params: ActiveUsersQueryParams): string {
    const queryParams = new URLSearchParams();

    if (params.hours !== undefined) {
      queryParams.append('hours', params.hours.toString());
    }

    if (params.limit !== undefined) {
      queryParams.append('limit', params.limit.toString());
    }

    const queryString = queryParams.toString();
    return queryString ? `?${queryString}` : '';
  }

  /**
   * Get active users for the specified time window
   * Supports hours (1-168) and limit (1-100) parameters
   */
  public async getActiveUsers(params: ActiveUsersQueryParams = {}): Promise<ActiveUsersApiResponse> {
    return this.circuitBreaker.execute(async () => {
      const queryString = this.buildQueryString({
        hours: params.hours || 24,
        limit: params.limit || 100
      });
      const endpoint = `/users/active${queryString}`;

      logDeduplicator.info('Fetching active users from HypeDexer', {
        endpoint,
        params
      });

      const response = await this.get<ActiveUsersApiResponse>(endpoint);

      logDeduplicator.info('Successfully fetched active users', {
        count: response.data?.length || 0,
        totalCount: response.total_count,
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
    return HLIndexerActiveUsersClient.REQUEST_WEIGHT;
  }
}
