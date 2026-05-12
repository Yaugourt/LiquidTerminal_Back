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

// TTLs for overview snapshots. 60s for most routes (active-traders, daily-pnl,
// daily-volume, total-fees, total-fills, trading-volume); coin-distribution
// is user-scoped + heavier upstream, cached longer.
const TTL_OVERVIEW_DEFAULT = 60;
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
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'active-traders-24h'),
      TTL_OVERVIEW_DEFAULT,
      () => this.getPath('/overview/active-traders-24h'),
    );
  }

  public getCoinDistribution(params: { user: string }): Promise<unknown> {
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'coin-distribution', params),
      TTL_COIN_DISTRIBUTION,
      () => this.getPath(`/overview/coin-distribution${buildQuery(params)}`),
    );
  }

  public getDailyPnl10d(): Promise<unknown> {
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'daily-pnl-10d'),
      TTL_OVERVIEW_DEFAULT,
      () => this.getPath('/overview/daily-pnl-10d'),
    );
  }

  public getDailyVolume10d(): Promise<unknown> {
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'daily-volume-10d'),
      TTL_OVERVIEW_DEFAULT,
      () => this.getPath('/overview/daily-volume-10d'),
    );
  }

  public getTotalFees24h(): Promise<unknown> {
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'total-fees-24h'),
      TTL_OVERVIEW_DEFAULT,
      () => this.getPath('/overview/total-fees-24h'),
    );
  }

  public getTotalFills24h(): Promise<unknown> {
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'total-fills-24h'),
      TTL_OVERVIEW_DEFAULT,
      () => this.getPath('/overview/total-fills-24h'),
    );
  }

  public getTradingVolume24h(): Promise<unknown> {
    return withRedisCache(
      buildHypedexerCacheKey('overview', 'trading-volume-24h'),
      TTL_OVERVIEW_DEFAULT,
      () => this.getPath('/overview/trading-volume-24h'),
    );
  }
}
