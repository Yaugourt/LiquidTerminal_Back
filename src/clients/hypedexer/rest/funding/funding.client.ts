import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

export interface IndexerFundingHistoryQuery {
  coin: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface IndexerUserFundingQuery {
  user: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

/**
 * HypeDexer REST — Funding (camelCase query keys per OpenAPI).
 */
export class HypeDexerFundingClient extends HypeDexerBaseClient {
  private static instance: HypeDexerFundingClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-funding');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-funding', {
      maxWeightPerMinute: HypeDexerFundingClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerFundingClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerFundingClient {
    if (!HypeDexerFundingClient.instance) {
      HypeDexerFundingClient.instance = new HypeDexerFundingClient();
    }
    return HypeDexerFundingClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private buildHistoryQuery(params: IndexerFundingHistoryQuery): string {
    const sp = new URLSearchParams();
    sp.append('coin', params.coin);
    if (params.startTime) sp.append('startTime', params.startTime);
    if (params.endTime) sp.append('endTime', params.endTime);
    if (params.limit !== undefined) sp.append('limit', String(params.limit));
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private buildUserFundingQuery(params: IndexerUserFundingQuery): string {
    const sp = new URLSearchParams();
    sp.append('user', params.user);
    if (params.startTime) sp.append('startTime', params.startTime);
    if (params.endTime) sp.append('endTime', params.endTime);
    if (params.limit !== undefined) sp.append('limit', String(params.limit));
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  public async getFundingHistory(params: IndexerFundingHistoryQuery): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildHistoryQuery(params);
      const path = `/funding/fundingHistory${q}`;
      logDeduplicator.info('HypeDexerFundingClient.getFundingHistory', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getPredictedFundings(): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerFundingClient.getPredictedFundings');
      return this.getUnwrapped<unknown>('/funding/predictedFundings');
    });
  }

  public async getUserFunding(params: IndexerUserFundingQuery): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildUserFundingQuery(params);
      const path = `/funding/userFunding${q}`;
      logDeduplicator.info('HypeDexerFundingClient.getUserFunding', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }
}
