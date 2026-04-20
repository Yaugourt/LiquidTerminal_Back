import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

export interface IndexerUsersLeaderboardQuery {
  by?: 'volume' | 'pnl' | 'trades' | 'priority_fees';
  hours?: number;
  limit?: number;
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
    return this.circuitBreaker.execute(async () => {
      const sp = new URLSearchParams();
      sp.append('by', q.by ?? 'volume');
      sp.append('hours', String(q.hours ?? 24));
      sp.append('limit', String(q.limit ?? 20));
      const endpoint = `/users/leaderboard?${sp.toString()}`;
      logDeduplicator.info('HypeDexerUsersIndexerClient.getLeaderboard', { endpoint });
      return this.getUnwrapped<unknown>(endpoint);
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
