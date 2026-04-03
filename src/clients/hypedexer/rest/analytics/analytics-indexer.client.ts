import { BaseApiService } from '../../../../core/base.api.service';
import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import type { HypeDexerApiResponse } from '../../../../types/hypedexer-api.types';

export interface IndexerAnalyticsFillsStatsQuery {
  hours?: number;
  coin?: string | null;
}

/**
 * HypeDexer REST — Analytics (GET /analytics/fills/stats).
 */
export class HypeDexerAnalyticsIndexerClient extends BaseApiService {
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

  public async getFillsStats(params: IndexerAnalyticsFillsStatsQuery = {}): Promise<HypeDexerApiResponse> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildFillsStatsQuery(params);
      const path = `/analytics/fills/stats${q}`;
      logDeduplicator.info('HypeDexerAnalyticsIndexerClient.getFillsStats', { path });
      return this.get<HypeDexerApiResponse>(path);
    });
  }
}
