import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';
import { buildHypedexerCacheKey, withRedisCache } from '../shared/hypedexer-cache.helper';

function buildQuery(record: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// The fixed-name snapshots (active traders, daily PnL, daily volume, fees,
// fills, trading volume) are not cached here: IndexerOverviewService caches
// them under the same keys with their own TTLs (15 s for the 24h tiles), one
// fetch per key across visitors. A second cache here held them up to 60 s
// whenever it was the one that wrote the key. Coin distribution is per user
// and heavier upstream, cached longer.
const TTL_COIN_DISTRIBUTION = 300;

/**
 * HypeDexer REST — Overview analytics snapshots (GET-only, no path params).
 */
export class HypeDexerOverviewIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerOverviewIndexerClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-overview');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-overview', {
      maxWeightPerMinute: HypeDexerOverviewIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerOverviewIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerOverviewIndexerClient {
    if (!HypeDexerOverviewIndexerClient.instance) {
      HypeDexerOverviewIndexerClient.instance = new HypeDexerOverviewIndexerClient();
    }
    return HypeDexerOverviewIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private async getPath(path: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerOverviewIndexerClient', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getActiveTraders24h(): Promise<unknown> {
    return this.getPath('/overview/active-traders-24h');
  }

  public getCoinDistribution(params: { user: string }): Promise<unknown> {
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'coin-distribution', params),
      TTL_COIN_DISTRIBUTION,
      () => this.getPath(`/overview/coin-distribution${buildQuery(params)}`),
    );
  }

  public getDailyPnl10d(): Promise<unknown> {
    return this.getPath('/overview/daily-pnl-10d');
  }

  public getDailyVolume10d(): Promise<unknown> {
    return this.getPath('/overview/daily-volume-10d');
  }

  public getTotalFees24h(): Promise<unknown> {
    return this.getPath('/overview/total-fees-24h');
  }

  public getTotalFills24h(): Promise<unknown> {
    return this.getPath('/overview/total-fills-24h');
  }

  public getTradingVolume24h(): Promise<unknown> {
    return this.getPath('/overview/trading-volume-24h');
  }
}
