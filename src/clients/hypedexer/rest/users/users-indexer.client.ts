import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';
import { buildHypedexerCacheKey, withRedisCache } from '../shared/hypedexer-cache.helper';
import type { LeaderboardMetric, LeaderboardWindow } from '../../../../constants/indexer-leaderboard.constants';

const TTL_LEADERBOARD = 60;

export interface IndexerUsersLeaderboardQuery {
  by?: 'volume' | 'pnl' | 'trades' | 'priority_fees';
  hours?: number;
  limit?: number;
}

export interface IndexerUsersLeaderboardWindowQuery {
  window: LeaderboardWindow;
  by: LeaderboardMetric;
  page: number;
  limit: number;
}

/** One page of a ranking over a window. */
export interface IndexerUsersLeaderboardPage {
  rows: unknown[];
  /** Addresses ranked in all; null when the provider does not say. */
  total: number | null;
}

/**
 * HypeDexer REST — Users domain (leaderboard pass-through; `/users/active` polling client lives in `rest/activeusers/`).
 */
export class HypeDexerUsersIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerUsersIndexerClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-users');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-users', {
      maxWeightPerMinute: HypeDexerUsersIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerUsersIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerUsersIndexerClient {
    if (!HypeDexerUsersIndexerClient.instance) {
      HypeDexerUsersIndexerClient.instance = new HypeDexerUsersIndexerClient();
    }
    return HypeDexerUsersIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public async getLeaderboard(q: IndexerUsersLeaderboardQuery = {}): Promise<unknown> {
    const by = q.by ?? 'volume';
    const hours = q.hours ?? 24;
    const limit = q.limit ?? 20;
    return withRedisCache(
      buildHypedexerCacheKey('users', 'leaderboard', { by, hours, limit }),
      TTL_LEADERBOARD,
      () =>
        this.circuitBreaker.execute(async () => {
          const sp = new URLSearchParams();
          sp.append('by', by);
          sp.append('hours', String(hours));
          sp.append('limit', String(limit));
          const endpoint = `/users/leaderboard?${sp.toString()}`;
          logDeduplicator.info('HypeDexerUsersIndexerClient.getLeaderboard', { endpoint });
          return this.getUnwrapped<unknown>(endpoint);
        }),
    );
  }

  /**
   * Addresses ranked over a window, one page of them: volume, PnL (realized and unrealized), fees,
   * win rate, account value, and when the provider computed it (`refreshed_at`, epoch ms).
   */
  public async getLeaderboardWindow(q: IndexerUsersLeaderboardWindowQuery): Promise<IndexerUsersLeaderboardPage> {
    return this.circuitBreaker.execute(async () => {
      const sp = new URLSearchParams({ window: q.window, by: q.by, page: String(q.page), limit: String(q.limit) });
      const endpoint = `/users/leaderboard?${sp.toString()}`;
      logDeduplicator.info('HypeDexerUsersIndexerClient.getLeaderboardWindow', { endpoint });
      return toLeaderboardPage(await this.getEnvelope(endpoint));
    });
  }

  public async getUserCoins(
    user: string,
    params: { start_time?: string; end_time?: string; limit?: number } = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const sp = new URLSearchParams();
      if (params.start_time) sp.append('start_time', params.start_time);
      if (params.end_time) sp.append('end_time', params.end_time);
      if (params.limit !== undefined) sp.append('limit', String(params.limit));
      const qs = sp.toString();
      const path = `/users/${encodeURIComponent(user)}/coins${qs ? `?${qs}` : ''}`;
      logDeduplicator.info('HypeDexerUsersIndexerClient.getUserCoins', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getUserOverview(
    user: string,
    params: { start_time?: string; end_time?: string } = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const sp = new URLSearchParams();
      if (params.start_time) sp.append('start_time', params.start_time);
      if (params.end_time) sp.append('end_time', params.end_time);
      const qs = sp.toString();
      const path = `/users/${encodeURIComponent(user)}/overview${qs ? `?${qs}` : ''}`;
      logDeduplicator.info('HypeDexerUsersIndexerClient.getUserOverview', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getUserPerformance(
    user: string,
    params: { start_time?: string; end_time?: string } = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const sp = new URLSearchParams();
      if (params.start_time) sp.append('start_time', params.start_time);
      if (params.end_time) sp.append('end_time', params.end_time);
      const qs = sp.toString();
      const path = `/users/${encodeURIComponent(user)}/performance${qs ? `?${qs}` : ''}`;
      logDeduplicator.info('HypeDexerUsersIndexerClient.getUserPerformance', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }
}

function toLeaderboardPage(body: unknown): IndexerUsersLeaderboardPage {
  const envelope = (body ?? {}) as { success?: unknown; data?: unknown; total_count?: unknown };
  if (envelope.success === false || !Array.isArray(envelope.data)) {
    throw new Error('Unexpected leaderboard payload');
  }
  return {
    rows: envelope.data,
    total: typeof envelope.total_count === 'number' ? envelope.total_count : null,
  };
}
