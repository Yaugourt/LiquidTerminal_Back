/**
 * Active User data from HypeDexer API
 * GET /users/active
 */
export interface ActiveUser {
  user: string;           // Wallet address (0x...)
  fill_count: number;     // Number of fills/trades
  total_volume: number;   // Total trading volume in USD
  unique_coins: number;   // Number of unique coins traded
  last_activity: string;  // ISO datetime of last activity
}

/**
 * The lookback windows GET /active-users serves (the ones the front offers):
 * every other value is a billed HypeDexer call of its own, so the route
 * refuses it. 1, 4, 12 and 24 are kept warm by the poller, 168 is read on
 * demand and shared.
 */
export const ACTIVE_USERS_HOURS = [1, 4, 12, 24, 168] as const;

/**
 * Query parameters for active users API
 */
export interface ActiveUsersQueryParams {
  hours?: number;  // Lookback window in hours (one of ACTIVE_USERS_HOURS, default: 24)
  limit?: number;  // Max users (1-100, default: 100)
}

/**
 * Response from HypeDexer API (original format)
 */
export interface ActiveUsersApiResponse {
  success: boolean;
  message: string;
  data: ActiveUser[];
  total_count: number | null;
  execution_time_ms: number;
  next_cursor: string | null;
  has_more: boolean | null;
}

/**
 * Our API response format (transformed)
 */
export interface ActiveUsersResponse {
  success: boolean;
  data: ActiveUser[];
  metadata: {
    hours: number;
    limit: number;
    totalCount: number;
    executionTimeMs: number;
    cachedAt: string;
  };
}

/**
 * Active Users error class
 */
export class ActiveUsersError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = 'ACTIVE_USERS_ERROR'
  ) {
    super(message);
    this.name = 'ActiveUsersError';
  }
}
