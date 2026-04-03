import { HLIndexerBuildersClient } from '../../clients/hypedexer/rest/builders/builders-list-poller.client';
import {
  Builder,
  BuildersQueryParams,
  BuildersListResponse,
  BuildersStatsResponse,
  BuildersStats,
  BuildersError,
  BuildersSortField
} from '../../types/builders.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Service for Builders business logic
 * Reads all builders from cache, applies pagination/filtering/sorting locally
 */
export class BuildersService {
  private static instance: BuildersService;
  private readonly client: HLIndexerBuildersClient;

  private constructor() {
    this.client = HLIndexerBuildersClient.getInstance();
  }

  public static getInstance(): BuildersService {
    if (!BuildersService.instance) {
      BuildersService.instance = new BuildersService();
    }
    return BuildersService.instance;
  }

  public async getBuilders(params: BuildersQueryParams = {}): Promise<BuildersListResponse> {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const sortBy = params.sortBy || 'volume_usd';
    const sortOrder = params.sortOrder || 'desc';
    const search = params.search?.toLowerCase();

    try {
      const response = await this.client.getAllBuilders();
      let builders = response.data;

      // Filter by search (name or address)
      if (search) {
        builders = builders.filter(b =>
          (b.name && b.name.toLowerCase().includes(search)) ||
          b.builder_address.toLowerCase().includes(search)
        );
      }

      // Sort
      builders = this.sortBuilders(builders, sortBy, sortOrder);

      // Paginate
      const total = builders.length;
      const totalPages = Math.ceil(total / limit);
      const start = (page - 1) * limit;
      const end = start + limit;
      const paginatedData = builders.slice(start, end);

      return {
        success: true,
        data: paginatedData,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        },
        metadata: {
          cachedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logDeduplicator.error('BuildersService.getBuilders failed', {
        error: error instanceof Error ? error.message : String(error),
        params
      });
      throw new BuildersError(
        error instanceof Error ? error.message : 'Failed to fetch builders',
        500,
        'BUILDERS_SERVICE_ERROR'
      );
    }
  }

  public async getStats(): Promise<BuildersStatsResponse> {
    try {
      const response = await this.client.getAllBuilders();
      const builders = response.data;

      const stats: BuildersStats = {
        totalFees: 0,
        totalVolume: 0,
        totalTradesCount: 0,
        totalUniqueUsers: 0,
        totalBuilders: builders.length
      };

      for (const b of builders) {
        stats.totalFees += b.fees_usd;
        stats.totalVolume += b.volume_usd;
        stats.totalTradesCount += b.trades_count;
        stats.totalUniqueUsers += b.unique_users;
      }

      return {
        success: true,
        data: stats,
        metadata: {
          cachedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      logDeduplicator.error('BuildersService.getStats failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw new BuildersError(
        error instanceof Error ? error.message : 'Failed to fetch builders stats',
        500,
        'BUILDERS_STATS_ERROR'
      );
    }
  }

  private sortBuilders(builders: Builder[], sortBy: BuildersSortField, sortOrder: string): Builder[] {
    const multiplier = sortOrder === 'desc' ? -1 : 1;

    return [...builders].sort((a, b) => {
      if (sortBy === 'name') {
        const nameA = (a.name || '').toLowerCase();
        const nameB = (b.name || '').toLowerCase();
        return multiplier * nameA.localeCompare(nameB);
      }
      return multiplier * ((a[sortBy] as number) - (b[sortBy] as number));
    });
  }

  public checkRateLimit(ip: string): boolean {
    return this.client.checkRateLimit(ip);
  }
}
