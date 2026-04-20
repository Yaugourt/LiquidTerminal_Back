import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

export interface IndexerFillsQuery {
  user?: string;
  coin?: string;
  side?: string;
  size_usd?: number;
  start_time?: string;
  end_time?: string;
  offset?: number;
  limit?: number;
  cursor?: string;
  order?: string;
  /** When set, filter fills with/without priority gas (omitted = no filter). */
  has_priority_gas?: boolean;
}

export interface IndexerFillsUserByAddressQuery {
  time_range?: string;
  coin?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  order?: string;
  has_priority_gas?: boolean;
}

export interface IndexerFillsSpotQuery {
  user?: string;
  coin?: string;
  coins?: string;
  side?: string;
  start_time?: string;
  end_time?: string;
  offset?: number;
  limit?: number;
  order?: string;
  has_priority_gas?: boolean;
}

/**
 * HypeDexer REST — Fills domain (OpenAPI tag Fills).
 */
export class HypeDexerFillsClient extends HypeDexerBaseClient {
  private static instance: HypeDexerFillsClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-fills');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-fills', {
      maxWeightPerMinute: HypeDexerFillsClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerFillsClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerFillsClient {
    if (!HypeDexerFillsClient.instance) {
      HypeDexerFillsClient.instance = new HypeDexerFillsClient();
    }
    return HypeDexerFillsClient.instance;
  }

  private buildQuery(params: IndexerFillsQuery): string {
    const sp = new URLSearchParams();
    const entries: [string, string | number | boolean | undefined][] = [
      ['user', params.user],
      ['coin', params.coin],
      ['side', params.side],
      ['size_usd', params.size_usd],
      ['start_time', params.start_time],
      ['end_time', params.end_time],
      ['offset', params.offset],
      ['limit', params.limit],
      ['cursor', params.cursor],
      ['order', params.order],
      ['has_priority_gas', params.has_priority_gas],
    ];
    for (const [k, v] of entries) {
      if (v === undefined || v === null || v === '') continue;
      sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public async getFills(params: IndexerFillsQuery = {}): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildQuery(params);
      const endpoint = `/fills/${q}`;
      logDeduplicator.info('HypeDexerFillsClient.getFills', { endpoint });
      return this.getUnwrapped<unknown>(endpoint);
    });
  }

  public async getFillsRecent(params: IndexerFillsQuery = {}): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildQuery(params);
      const endpoint = `/fills/recent${q}`;
      logDeduplicator.info('HypeDexerFillsClient.getFillsRecent', { endpoint });
      return this.getUnwrapped<unknown>(endpoint);
    });
  }

  public async getFillsCount(): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerFillsClient.getFillsCount');
      return this.getUnwrapped<unknown>('/fills/count');
    });
  }

  private buildUserByAddressQuery(params: IndexerFillsUserByAddressQuery): string {
    const sp = new URLSearchParams();
    const entries: [string, string | number | boolean | undefined][] = [
      ['time_range', params.time_range],
      ['coin', params.coin],
      ['limit', params.limit],
      ['offset', params.offset],
      ['cursor', params.cursor],
      ['order', params.order],
      ['has_priority_gas', params.has_priority_gas],
    ];
    for (const [k, v] of entries) {
      if (v === undefined || v === null || v === '') continue;
      sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private buildSpotQuery(params: IndexerFillsSpotQuery): string {
    const sp = new URLSearchParams();
    const entries: [string, string | number | boolean | undefined][] = [
      ['user', params.user],
      ['coin', params.coin],
      ['coins', params.coins],
      ['side', params.side],
      ['start_time', params.start_time],
      ['end_time', params.end_time],
      ['offset', params.offset],
      ['limit', params.limit],
      ['order', params.order],
      ['has_priority_gas', params.has_priority_gas],
    ];
    for (const [k, v] of entries) {
      if (v === undefined || v === null || v === '') continue;
      sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  public async getUserFills(
    userAddress: string,
    params: IndexerFillsUserByAddressQuery = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const enc = encodeURIComponent(userAddress);
      const q = this.buildUserByAddressQuery(params);
      const endpoint = `/fills/user/${enc}${q}`;
      logDeduplicator.info('HypeDexerFillsClient.getUserFills', { endpoint });
      return this.getUnwrapped<unknown>(endpoint);
    });
  }

  public async getSpotFills(params: IndexerFillsSpotQuery = {}): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildSpotQuery(params);
      const endpoint = q ? `/fills/spot/${q}` : '/fills/spot/';
      logDeduplicator.info('HypeDexerFillsClient.getSpotFills', { endpoint });
      return this.getUnwrapped<unknown>(endpoint);
    });
  }

  public async getSpotUserFills(
    userAddress: string,
    params: Omit<IndexerFillsSpotQuery, 'user'> = {}
  ): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const enc = encodeURIComponent(userAddress);
      const q = this.buildSpotQuery(params);
      const endpoint = `/fills/spot/user/${enc}${q}`;
      logDeduplicator.info('HypeDexerFillsClient.getSpotUserFills', { endpoint });
      return this.getUnwrapped<unknown>(endpoint);
    });
  }
}
