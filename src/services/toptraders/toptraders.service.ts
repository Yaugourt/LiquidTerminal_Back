import { HLIndexerTopTradersClient } from '../../clients/hlindexer/toptraders/toptraders.client';
import {
  TopTradersResponse,
  TopTradersQueryParams,
  TopTradersError,
  TopTradersSortType
} from '../../types/toptraders.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Service for Top Traders business logic
 * Delegates polling/caching to client; transforms API response to TopTradersResponse
 */
export class TopTradersService {
  private static instance: TopTradersService;
  private readonly client: HLIndexerTopTradersClient;

  private constructor() {
    this.client = HLIndexerTopTradersClient.getInstance();
  }

  public static getInstance(): TopTradersService {
    if (!TopTradersService.instance) {
      TopTradersService.instance = new TopTradersService();
    }
    return TopTradersService.instance;
  }

  public startPolling(): void {
    this.client.startPolling();
  }

  public stopPolling(): void {
    this.client.stopPolling();
  }

  public async getTopTraders(params: TopTradersQueryParams = {}): Promise<TopTradersResponse> {
    const sort = params.sort || 'pnl_pos';
    const limit = params.limit || 50;

    try {
      const response = await this.client.getTopTraders({ sort, limit });
      return {
        success: true,
        data: response.data,
        metadata: {
          sort: sort as TopTradersSortType,
          limit,
          executionTimeMs: response.execution_time_ms,
          cachedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logDeduplicator.error('TopTradersService.getTopTraders failed', {
        error: error instanceof Error ? error.message : String(error),
        params
      });
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

  public checkRateLimit(ip: string): boolean {
    return this.client.checkRateLimit(ip);
  }
}
