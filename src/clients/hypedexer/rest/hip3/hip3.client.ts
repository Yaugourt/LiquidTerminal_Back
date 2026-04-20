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
 * HypeDexer REST — HIP-3 (perp deployer) domain.
 */
export class HypeDexerHip3Client extends HypeDexerBaseClient {
  private static instance: HypeDexerHip3Client;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-hip3');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-hip3', {
      maxWeightPerMinute: HypeDexerHip3Client.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerHip3Client.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerHip3Client {
    if (!HypeDexerHip3Client.instance) {
      HypeDexerHip3Client.instance = new HypeDexerHip3Client();
    }
    return HypeDexerHip3Client.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private async getUpstream(path: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerHip3Client', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getAssets(params: {
    dex_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/assets${buildQuery(params)}`);
  }

  public getAssetByTicker(ticker: string): Promise<unknown> {
    return this.getUpstream(`/hip3/assets/${encodeURIComponent(ticker)}`);
  }

  public getDexs(params: { limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/dexs${buildQuery(params)}`);
  }

  public getDexById(dexId: string): Promise<unknown> {
    return this.getUpstream(`/hip3/dexs/${encodeURIComponent(dexId)}`);
  }

  public getOverview(): Promise<unknown> {
    return this.getUpstream('/hip3/overview');
  }

  public getPriorityFeesGossipStatus(): Promise<unknown> {
    return this.getUpstream('/hip3/priority-fees/gossip/status');
  }

  public getPriorityFeesGossipHistory(
    params: {
      slot_id?: number;
      start_time?: string;
      end_time?: string;
      offset?: number;
      limit?: number;
      order?: string;
    } = {}
  ): Promise<unknown> {
    return this.getUpstream(`/hip3/priority-fees/gossip/history${buildQuery(params)}`);
  }

  public getAuctions(params: { status?: string; limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/auctions${buildQuery(params)}`);
  }

  public getAuctionCurrent(): Promise<unknown> {
    return this.getUpstream('/hip3/auctions/current');
  }

  public getAuctionsHistory(params: { dex_id?: string; limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/auctions/history${buildQuery(params)}`);
  }

  public getFills(params: {
    dex_id?: string;
    coin?: string;
    user?: string;
    side?: string;
    start?: string;
    end?: string;
    min_notional?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/fills${buildQuery(params)}`);
  }

  public getLeaderboard(params: { by?: string; dex_id?: string; limit?: number } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/leaderboard${buildQuery(params)}`);
  }

  public getOhlcv(params: {
    coin: string;
    dex_id?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<unknown> {
    return this.getUpstream(`/hip3/ohlcv${buildQuery(params)}`);
  }

  public getOracleStats(params: {
    dex_id: string;
    asset_id?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<unknown> {
    return this.getUpstream(`/hip3/oracle/stats${buildQuery(params)}`);
  }

  public getSnapshots(params: { dex_id?: string; coin?: string } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/snapshots${buildQuery(params)}`);
  }

  public getStatsTraders(params: {
    dex_id?: string;
    coin?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/stats/traders${buildQuery(params)}`);
  }

  public getTopMovers(params: { limit?: number } = {}): Promise<unknown> {
    return this.getUpstream(`/hip3/top-movers${buildQuery(params)}`);
  }

  public getUserCoins(address: string, params: { limit?: number } = {}): Promise<unknown> {
    const enc = encodeURIComponent(address);
    return this.getUpstream(`/hip3/users/${enc}/coins${buildQuery(params)}`);
  }

  public getUserFills(
    address: string,
    params: {
      coin?: string;
      dex_id?: string;
      start?: string;
      end?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<unknown> {
    const enc = encodeURIComponent(address);
    return this.getUpstream(`/hip3/users/${enc}/fills${buildQuery(params)}`);
  }

  public getUserOverview(address: string): Promise<unknown> {
    const enc = encodeURIComponent(address);
    return this.getUpstream(`/hip3/users/${enc}/overview`);
  }
}
