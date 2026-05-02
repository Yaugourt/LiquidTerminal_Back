import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

function buildQuery(record: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * HypeDexer REST — HIP-4 (prediction markets) domain.
 */
export class HypeDexerHip4Client extends HypeDexerBaseClient {
  private static instance: HypeDexerHip4Client;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-hip4');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-hip4', {
      maxWeightPerMinute: HypeDexerHip4Client.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerHip4Client.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerHip4Client {
    if (!HypeDexerHip4Client.instance) {
      HypeDexerHip4Client.instance = new HypeDexerHip4Client();
    }
    return HypeDexerHip4Client.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private async getUpstream(path: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerHip4Client', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  /** Prediction market fills. */
  public getFills<T = unknown>(params: {
    user?: string;
    coin?: string;
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<T> {
    return this.getUpstream(`/hip4/fills${buildQuery(params)}`) as Promise<T>;
  }

  /** Outcome markets with question/volume stats — used by enriched endpoints. */
  public getMarkets<T = unknown>(params: {
    outcome_id?: number;
    class?: string;
    underlying?: string;
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<T> {
    return this.getUpstream(`/hip4/markets${buildQuery(params)}`) as Promise<T>;
  }

  /** Questions grouping related outcomes — used by enriched endpoints. */
  public getQuestions<T = unknown>(params: {
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<T> {
    return this.getUpstream(`/hip4/questions${buildQuery(params)}`) as Promise<T>;
  }

  /** Market resolutions. */
  public getSettlements<T = unknown>(params: {
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<T> {
    return this.getUpstream(`/hip4/settlements${buildQuery(params)}`) as Promise<T>;
  }

  /** Outcome token metadata — used by enriched endpoints for human-readable names. */
  public getOutcomeTokens<T = unknown>(params: {
    outcome_id?: number;
    coin?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<T> {
    return this.getUpstream(`/hip4/outcome-tokens${buildQuery(params)}`) as Promise<T>;
  }
}
