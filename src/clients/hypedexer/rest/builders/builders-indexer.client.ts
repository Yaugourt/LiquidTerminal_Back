import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

export type IndexerBuildersTimeframe = '1h' | '24h' | '7d' | '30d';

export interface IndexerBuildersTopQuery {
  timeframe?: IndexerBuildersTimeframe;
  sort?: string;
  limit?: number;
}

export interface IndexerBuilderDetailQuery {
  timeframe?: IndexerBuildersTimeframe;
}

export interface IndexerBuilderUsersQuery {
  timeframe?: IndexerBuildersTimeframe;
  limit?: number;
}

/**
 * HypeDexer REST — Builders (OpenAPI paths under /builders/*).
 */
export class HypeDexerBuildersIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerBuildersIndexerClient;
  private static readonly REQUEST_WEIGHT = 12;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;
  /** Per-builder HypeDexer routes can exceed 30s; avoid withRetry(×3) stacking timeouts. */
  private static readonly SLOW_LEAF_TIMEOUT_MS = 120_000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    // Builders hub fires several parallel indexer calls on mount; use a slightly
    // higher failure budget so transient upstream blips do not trip the breaker
    // as fast as a single-threaded client would.
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-builders-rest', {
      maxFailures: 15,
      circuitBreakerTimeout: 90_000,
    });
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-builders-rest', {
      maxWeightPerMinute: HypeDexerBuildersIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerBuildersIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerBuildersIndexerClient {
    if (!HypeDexerBuildersIndexerClient.instance) {
      HypeDexerBuildersIndexerClient.instance = new HypeDexerBuildersIndexerClient();
    }
    return HypeDexerBuildersIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  /**
   * OpenAPI: GET /builders/list — optional legacy query for sort/pagination (upstream may accept).
   */
  public async listBuilders(legacyQuery?: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const path = legacyQuery ? `/builders/list${legacyQuery}` : '/builders/list';
      logDeduplicator.info('HypeDexerBuildersIndexerClient.listBuilders', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getGlobalStats(timeframe?: IndexerBuildersTimeframe): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q =
        timeframe !== undefined
          ? `?${new URLSearchParams({ timeframe }).toString()}`
          : '';
      const path = `/builders/stats${q}`;
      logDeduplicator.info('HypeDexerBuildersIndexerClient.getGlobalStats', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getStatsAllTimeframes(): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerBuildersIndexerClient.getStatsAllTimeframes');
      return this.getUnwrapped<unknown>('/builders/stats/all-timeframes');
    });
  }

  public async getTopBuilders(params: IndexerBuildersTopQuery = {}): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const sp = new URLSearchParams();
      if (params.timeframe !== undefined) sp.append('timeframe', params.timeframe);
      if (params.sort !== undefined) sp.append('sort', params.sort);
      if (params.limit !== undefined) sp.append('limit', String(params.limit));
      const q = sp.toString();
      const path = `/builders/top${q ? `?${q}` : ''}`;
      logDeduplicator.info('HypeDexerBuildersIndexerClient.getTopBuilders', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getBuilderStats(
    builderAddress: string,
    params: IndexerBuilderDetailQuery = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const enc = encodeURIComponent(builderAddress);
      const q =
        params.timeframe !== undefined
          ? `?${new URLSearchParams({ timeframe: params.timeframe }).toString()}`
          : '';
      const path = `/builders/${enc}/stats${q}`;
      logDeduplicator.info('HypeDexerBuildersIndexerClient.getBuilderStats', { path });
      return this.getSingleAttemptUnwrapped<unknown>(path, HypeDexerBuildersIndexerClient.SLOW_LEAF_TIMEOUT_MS);
    });
  }

  public async getBuilderUsers(
    builderAddress: string,
    params: IndexerBuilderUsersQuery = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const enc = encodeURIComponent(builderAddress);
      const sp = new URLSearchParams();
      if (params.timeframe !== undefined) sp.append('timeframe', params.timeframe);
      if (params.limit !== undefined) sp.append('limit', String(params.limit));
      const q = sp.toString();
      const path = `/builders/${enc}/users${q ? `?${q}` : ''}`;
      logDeduplicator.info('HypeDexerBuildersIndexerClient.getBuilderUsers', { path });
      return this.getSingleAttemptUnwrapped<unknown>(path, HypeDexerBuildersIndexerClient.SLOW_LEAF_TIMEOUT_MS);
    });
  }
}
