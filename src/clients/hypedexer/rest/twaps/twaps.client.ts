import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

function q(record: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface IndexerTwapsListQuery {
  user?: string;
  coin?: string;
  status?: string;
  hours?: number;
  limit?: number;
  offset?: number;
  order?: string;
}

export interface IndexerTwapsStatsQuery {
  hours?: number;
  coin?: string;
}

export interface IndexerTwapsUserQuery {
  status?: string;
  coin?: string;
  hours?: number;
  limit?: number;
  offset?: number;
  order?: string;
}

/**
 * HypeDexer REST — TWAPs.
 */
export class HypeDexerTwapsClient extends HypeDexerBaseClient {
  private static instance: HypeDexerTwapsClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-twaps');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-twaps', {
      maxWeightPerMinute: HypeDexerTwapsClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerTwapsClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerTwapsClient {
    if (!HypeDexerTwapsClient.instance) {
      HypeDexerTwapsClient.instance = new HypeDexerTwapsClient();
    }
    return HypeDexerTwapsClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private getPath(path: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerTwapsClient', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public listTwaps(params: IndexerTwapsListQuery = {}): Promise<unknown> {
    const qs = q(params);
    return this.getPath(qs ? `/twaps/${qs}` : '/twaps/');
  }

  public getStats(params: IndexerTwapsStatsQuery = {}): Promise<unknown> {
    return this.getPath(`/twaps/stats${q(params)}`);
  }

  public getUserTwaps(userAddress: string, params: IndexerTwapsUserQuery = {}): Promise<unknown> {
    const enc = encodeURIComponent(userAddress);
    return this.getPath(`/twaps/user/${enc}${q(params)}`);
  }

  public getTwap(twapId: string): Promise<unknown> {
    return this.getPath(`/twaps/${encodeURIComponent(twapId)}`);
  }

  public getTwapFills(
    twapId: string,
    params: { limit?: number; offset?: number; order?: string } = {}
  ): Promise<unknown> {
    return this.getPath(`/twaps/${encodeURIComponent(twapId)}/fills${q(params)}`);
  }
}
