import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

export interface IndexerCompletedTradesQuery {
  user?: string | null;
  coin?: string | null;
  direction?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  min_pnl?: number | null;
  max_pnl?: number | null;
  offset?: number;
  limit?: number | null;
  do_count?: boolean;
  sort_by?: string;
  sort_dir?: string;
}

export interface IndexerCompletedTradesSummaryQuery {
  user?: string | null;
  coin?: string | null;
  direction?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}

/**
 * HypeDexer REST — Completed trades.
 */
export class HypeDexerCompletedTradesClient extends HypeDexerBaseClient {
  private static instance: HypeDexerCompletedTradesClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-completed-trades');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-completed-trades', {
      maxWeightPerMinute: HypeDexerCompletedTradesClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerCompletedTradesClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerCompletedTradesClient {
    if (!HypeDexerCompletedTradesClient.instance) {
      HypeDexerCompletedTradesClient.instance = new HypeDexerCompletedTradesClient();
    }
    return HypeDexerCompletedTradesClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private appendNullable(sp: URLSearchParams, key: string, v: string | number | boolean | null | undefined): void {
    if (v === undefined || v === null || v === '') return;
    sp.append(key, String(v));
  }

  private buildListQuery(params: IndexerCompletedTradesQuery): string {
    const sp = new URLSearchParams();
    this.appendNullable(sp, 'user', params.user ?? undefined);
    this.appendNullable(sp, 'coin', params.coin ?? undefined);
    this.appendNullable(sp, 'direction', params.direction ?? undefined);
    this.appendNullable(sp, 'start_time', params.start_time ?? undefined);
    this.appendNullable(sp, 'end_time', params.end_time ?? undefined);
    if (params.min_pnl !== undefined && params.min_pnl !== null) sp.append('min_pnl', String(params.min_pnl));
    if (params.max_pnl !== undefined && params.max_pnl !== null) sp.append('max_pnl', String(params.max_pnl));
    if (params.offset !== undefined) sp.append('offset', String(params.offset));
    if (params.limit !== undefined && params.limit !== null) sp.append('limit', String(params.limit));
    if (params.do_count !== undefined) sp.append('do_count', String(params.do_count));
    if (params.sort_by !== undefined) sp.append('sort_by', params.sort_by);
    if (params.sort_dir !== undefined) sp.append('sort_dir', params.sort_dir);
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private buildSummaryQuery(params: IndexerCompletedTradesSummaryQuery): string {
    const sp = new URLSearchParams();
    this.appendNullable(sp, 'user', params.user ?? undefined);
    this.appendNullable(sp, 'coin', params.coin ?? undefined);
    this.appendNullable(sp, 'direction', params.direction ?? undefined);
    this.appendNullable(sp, 'start_time', params.start_time ?? undefined);
    this.appendNullable(sp, 'end_time', params.end_time ?? undefined);
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  public async listCompletedTrades(params: IndexerCompletedTradesQuery = {}): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildListQuery(params);
      const path = `/completed-trades/${q}`;
      logDeduplicator.info('HypeDexerCompletedTradesClient.listCompletedTrades', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getSummary(params: IndexerCompletedTradesSummaryQuery = {}): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const q = this.buildSummaryQuery(params);
      const path = `/completed-trades/summary${q}`;
      logDeduplicator.info('HypeDexerCompletedTradesClient.getSummary', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public async getTradeFills(tradeId: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const enc = encodeURIComponent(tradeId);
      const path = `/completed-trades/${enc}/fills`;
      logDeduplicator.info('HypeDexerCompletedTradesClient.getTradeFills', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }
}
