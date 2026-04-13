/**
 * Builder data from HypeDexer API
 * GET /builders/
 */
export interface Builder {
  builder_address: string;
  name: string | null;
  referred_by: string | null;
  referrer_stage: string;
  volume_usd: number;
  fees_usd: number;
  trades_count: number;
  unique_users: number;
}

/**
 * Sort options for builders
 */
export type BuildersSortField = 'volume_usd' | 'fees_usd' | 'trades_count' | 'unique_users' | 'name';

/**
 * Sort order
 */
export type BuildersSortOrder = 'asc' | 'desc';

/**
 * Query parameters for builders list
 */
export interface BuildersQueryParams {
  page?: number;
  limit?: number;
  sortBy?: BuildersSortField;
  sortOrder?: BuildersSortOrder;
  search?: string;
}

/**
 * Response from HypeDexer API (original format)
 */
export interface BuildersApiResponse {
  success: boolean;
  message: string;
  data: Builder[];
  total_count: number;
  execution_time_ms: number;
  next_cursor: string | null;
  has_more: boolean | null;
}

/**
 * Aggregated stats for all builders
 */
export interface BuildersStats {
  totalFees: number;
  totalVolume: number;
  totalTradesCount: number;
  totalUniqueUsers: number;
  totalBuilders: number;
}

/**
 * Our paginated API response format
 */
export interface BuildersListResponse {
  success: boolean;
  data: Builder[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
  metadata: {
    cachedAt: string;
  };
}

/**
 * Our stats API response format
 */
export interface BuildersStatsResponse {
  success: boolean;
  data: BuildersStats;
  metadata: {
    cachedAt: string;
  };
}

/**
 * Builders error class
 */
export class BuildersError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = 'BUILDERS_ERROR'
  ) {
    super(message);
    this.name = 'BuildersError';
  }
}
