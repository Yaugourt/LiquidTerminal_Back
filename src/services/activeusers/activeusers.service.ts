import { HLIndexerActiveUsersClient } from '../../clients/hlindexer/activeusers/activeusers.client';
import {
  ActiveUsersResponse,
  ActiveUsersQueryParams,
  ActiveUsersError
} from '../../types/activeusers.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Service for Active Users business logic
 * Follows the Singleton pattern as per architecture
 * Polling and caching are owned by HLIndexerActiveUsersClient
 */
export class ActiveUsersService {
  private static instance: ActiveUsersService;
  private readonly client: HLIndexerActiveUsersClient;

  private constructor() {
    this.client = HLIndexerActiveUsersClient.getInstance();
  }

  public static getInstance(): ActiveUsersService {
    if (!ActiveUsersService.instance) {
      ActiveUsersService.instance = new ActiveUsersService();
    }
    return ActiveUsersService.instance;
  }

  /**
   * Get active users with optional filters
   * Delegates to client (which owns cache); wraps response in ActiveUsersResponse format
   */
  public async getActiveUsers(params: ActiveUsersQueryParams = {}): Promise<ActiveUsersResponse> {
    const hours = params.hours ?? 24;
    const limit = params.limit ?? 100;

    try {
      const response = await this.client.getActiveUsers(params);
      return {
        success: true,
        data: response.data,
        metadata: {
          hours,
          limit,
          totalCount: response.total_count ?? response.data.length,
          executionTimeMs: response.execution_time_ms,
          cachedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logDeduplicator.error('ActiveUsersService.getActiveUsers failed', {
        error: error instanceof Error ? error.message : String(error),
        params
      });

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        throw new ActiveUsersError(
          'API rate limit exceeded. Please try again in a few seconds.',
          429,
          'RATE_LIMIT_EXCEEDED'
        );
      }

      throw new ActiveUsersError(
        error instanceof Error ? error.message : 'Failed to fetch active users',
        500,
        'ACTIVE_USERS_SERVICE_ERROR'
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
