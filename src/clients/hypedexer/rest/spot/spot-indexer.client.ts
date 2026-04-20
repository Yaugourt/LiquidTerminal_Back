import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

function q(record: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * HypeDexer REST — Spot indexer (pairs, tokens, auctions).
 */
export class HypeDexerSpotIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerSpotIndexerClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-spot-indexer');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-spot-indexer', {
      maxWeightPerMinute: HypeDexerSpotIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerSpotIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerSpotIndexerClient {
    if (!HypeDexerSpotIndexerClient.instance) {
      HypeDexerSpotIndexerClient.instance = new HypeDexerSpotIndexerClient();
    }
    return HypeDexerSpotIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private getPath(path: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerSpotIndexerClient', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getAuctionsHist(params: { lookback_hours?: number; limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.getPath(`/spot/auctions/hist${q(params)}`);
  }

  public getAuctionsLive(params: { freshness_sec?: number } = {}): Promise<unknown> {
    return this.getPath(`/spot/auctions/live${q(params)}`);
  }

  public getPairs(params: { limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.getPath(`/spot/pairs${q(params)}`);
  }

  public getTokens(params: { search?: string; limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.getPath(`/spot/tokens${q(params)}`);
  }
}
