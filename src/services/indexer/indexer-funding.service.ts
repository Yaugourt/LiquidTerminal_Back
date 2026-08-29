import {
  HypeDexerFundingClient,
  IndexerFundingHistoryQuery,
  IndexerUserFundingQuery,
} from '../../clients/hypedexer/rest/funding/funding.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL, HYPEDEXER_USER_CACHE_KEY } from '../../constants/hypedexer.cache';

/** One coin's funding footprint for a wallet. */
export interface UserFundingSummaryCoin {
  coin: string;
  /** Net funding (received minus paid), USD. Negative = net cost. */
  net_usdc: number;
  /** Total funding paid (positive magnitude), USD. */
  paid_usdc: number;
  /** Total funding received (positive magnitude), USD. */
  received_usdc: number;
  count: number;
}

/** Aggregated funding ledger for a wallet over the fetched window. */
export interface UserFundingSummary {
  user: string;
  net_usdc: number;
  paid_usdc: number;
  received_usdc: number;
  event_count: number;
  /** Epoch-ms bounds of the events aggregated (null when none). */
  window: { start: number | null; end: number | null };
  by_coin: UserFundingSummaryCoin[];
}

interface RawFundingEvent {
  time?: string | number;
  coin?: string;
  usdc?: string | number;
}

export class IndexerFundingService {
  private static instance: IndexerFundingService;
  private readonly client = HypeDexerFundingClient.getInstance();

  public static getInstance(): IndexerFundingService {
    if (!IndexerFundingService.instance) {
      IndexerFundingService.instance = new IndexerFundingService();
    }
    return IndexerFundingService.instance;
  }

  public async getFundingHistory(params: IndexerFundingHistoryQuery): Promise<unknown> {
    return this.client.getFundingHistory(params);
  }

  public async getPredictedFundings(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.fundingPredicted,
      () => this.client.getPredictedFundings(),
      HYPEDEXER_TTL.globalRolling
    );
  }

  public async getUserFunding(params: IndexerUserFundingQuery): Promise<unknown> {
    if (params.startTime || params.endTime) {
      return this.client.getUserFunding(params);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.userFunding(params.user),
      () => this.client.getUserFunding(params),
      HYPEDEXER_TTL.userAddress
    );
  }

  /**
   * Aggregated funding ledger for a wallet: net funding paid vs received,
   * broken down by coin, over the fetched window. The upstream only exposes
   * individual funding events, so the aggregation is done here rather than on
   * the client — the front just displays the totals.
   */
  public async getUserFundingSummary(params: IndexerUserFundingQuery): Promise<UserFundingSummary> {
    const compute = async (): Promise<UserFundingSummary> => {
      const raw = await this.client.getUserFunding({ ...params, limit: params.limit ?? 5000 });
      const events: RawFundingEvent[] = Array.isArray(raw) ? (raw as RawFundingEvent[]) : [];

      let net = 0;
      let paid = 0;
      let received = 0;
      let minTime: number | null = null;
      let maxTime: number | null = null;
      const byCoin = new Map<string, UserFundingSummaryCoin>();

      for (const e of events) {
        const usdc =
          typeof e.usdc === 'string' ? parseFloat(e.usdc) : typeof e.usdc === 'number' ? e.usdc : NaN;
        if (!Number.isFinite(usdc)) continue;
        const coin = typeof e.coin === 'string' && e.coin ? e.coin : 'UNKNOWN';

        net += usdc;
        if (usdc < 0) paid += -usdc;
        else received += usdc;

        const t = typeof e.time === 'number' ? e.time : typeof e.time === 'string' ? Number(e.time) : NaN;
        if (Number.isFinite(t)) {
          if (minTime === null || t < minTime) minTime = t;
          if (maxTime === null || t > maxTime) maxTime = t;
        }

        const c =
          byCoin.get(coin) ?? { coin, net_usdc: 0, paid_usdc: 0, received_usdc: 0, count: 0 };
        c.net_usdc += usdc;
        if (usdc < 0) c.paid_usdc += -usdc;
        else c.received_usdc += usdc;
        c.count += 1;
        byCoin.set(coin, c);
      }

      const by_coin = Array.from(byCoin.values()).sort(
        (a, b) => Math.abs(b.net_usdc) - Math.abs(a.net_usdc)
      );

      return {
        user: params.user,
        net_usdc: net,
        paid_usdc: paid,
        received_usdc: received,
        event_count: events.length,
        window: { start: minTime, end: maxTime },
        by_coin,
      };
    };

    if (params.startTime || params.endTime) {
      return compute();
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.userFundingSummary(params.user),
      compute,
      HYPEDEXER_TTL.userAddress
    );
  }
}
