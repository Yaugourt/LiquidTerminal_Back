import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

export interface IndexerAnalyticsFillsStatsQuery {
  hours?: number;
  coin?: string | null;
}

/** Same query shape as fills stats (OpenAPI: hours 1–168, optional coin). */
export type IndexerAnalyticsPriorityFeesStatsQuery = IndexerAnalyticsFillsStatsQuery;

/**
 * HypeDexer REST — Analytics (GET /analytics/fills/stats).
 */
export class HypeDexerAnalyticsIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerAnalyticsIndexerClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-analytics');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-analytics', {
      maxWeightPerMinute: HypeDexerAnalyticsIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerAnalyticsIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerAnalyticsIndexerClient {
    if (!HypeDexerAnalyticsIndexerClient.instance) {
      HypeDexerAnalyticsIndexerClient.instance = new HypeDexerAnalyticsIndexerClient();
    }
    return HypeDexerAnalyticsIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private buildFillsStatsQuery(params: IndexerAnalyticsFillsStatsQuery): string {
    const sp = new URLSearchParams();
    if (params.hours !== undefined && params.hours !== null) {
      sp.append('hours', String(params.hours));
    }
    if (params.coin !== undefined && params.coin !== null && params.coin !== '') {
      sp.append('coin', params.coin);
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  public async getFillsStats(params: IndexerAnalyticsFillsStatsQuery = {}): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildFillsStatsQuery(params);
      const path = `/analytics/fills/stats${q}`;
      logDeduplicator.info('HypeDexerAnalyticsIndexerClient.getFillsStats', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getPriorityFeesStats(
    params: IndexerAnalyticsPriorityFeesStatsQuery = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildFillsStatsQuery(params);
      const path = `/analytics/priority-fees/stats${q}`;
      logDeduplicator.info('HypeDexerAnalyticsIndexerClient.getPriorityFeesStats', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }
}
