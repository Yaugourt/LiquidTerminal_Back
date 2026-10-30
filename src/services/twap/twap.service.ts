import { BaseApiService } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { redisService } from '../../core/redis.service';
import { MarketData, PerpMarketData } from '../../types/market.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { OnDemandSnapshot } from '../../utils/onDemandSnapshot';
import { HypeDexerInfoClient, viaInfoProxy } from '../../clients/hypedexer/rest/info/info.client';
import {
  AllPerpMetas,
  enrichTwapOrders,
  isActiveTwap,
  RawTwapOrder,
  TwapOrderWithMarket,
} from '../../utils/twap-enrichment.util';

class HypurrscanTwapClient extends BaseApiService {
  private readonly circuitBreaker = CircuitBreakerService.getInstance('hypurrscan_twap');

  constructor() {
    super(process.env.HYPURRSCAN_API_URL || 'https://api.hypurrscan.io');
  }

  getRecentOrders(): Promise<RawTwapOrder[]> {
    return this.circuitBreaker.execute(() => this.get<RawTwapOrder[]>('/twap/*'));
  }
}

class HyperliquidPerpMetasClient extends BaseApiService {
  constructor() {
    super((process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info');
  }

  /** Through HypeDexer's /info (byte-identical, 4 credits, no Hyperliquid weight), from Hyperliquid (weight 20) when that fails. */
  getAllPerpMetas(): Promise<AllPerpMetas> {
    return viaInfoProxy<AllPerpMetas>(
      'allPerpMetas',
      () => HypeDexerInfoClient.getInstance().allPerpMetas(),
      () => this.post<AllPerpMetas>('', { type: 'allPerpMetas' })
    );
  }
}

export interface TwapOrdersSnapshot {
  orders: TwapOrderWithMarket[];
  /** Epoch ms of the Hypurrscan download. */
  lastUpdate: number;
}

export class TwapUnavailableError extends Error {
  constructor() {
    super('TWAP orders unavailable');
    this.name = 'TwapUnavailableError';
  }
}

/**
 * TWAP orders of the last ~24 h with their market resolved. Every consumer
 * of the front (four on the dashboard) used to download Hypurrscan's whole
 * dump, `allPerpMetas` and the spot and perp lists every 30 s to enrich it in
 * the browser; this downloads the dump once per FRESH_MS for everyone, on
 * demand only (no poller).
 */
export class TwapService {
  private static instance: TwapService;

  private static readonly FRESH_MS = 15_000;
  private static readonly MAX_STALE_MS = 2 * 60_000;
  /** HIP-3 dex universes only change on a deploy. */
  private static readonly METAS_FRESH_MS = 5 * 60_000;
  private static readonly METAS_MAX_STALE_MS = 30 * 60_000;

  private readonly twapClient = new HypurrscanTwapClient();
  private readonly metasClient = new HyperliquidPerpMetasClient();

  private readonly orders = new OnDemandSnapshot(() => this.fetchOrders(), {
    freshMs: TwapService.FRESH_MS,
    maxStaleMs: TwapService.MAX_STALE_MS,
  });
  private readonly perpMetas = new OnDemandSnapshot(() => this.metasClient.getAllPerpMetas(), {
    freshMs: TwapService.METAS_FRESH_MS,
    maxStaleMs: TwapService.METAS_MAX_STALE_MS,
  });

  private constructor() {}

  public static getInstance(): TwapService {
    if (!TwapService.instance) {
      TwapService.instance = new TwapService();
    }
    return TwapService.instance;
  }

  /** `active` keeps the orders still running (not ended, no error). */
  public async getOrders(status: 'active' | 'all'): Promise<TwapOrdersSnapshot> {
    const snapshot = await this.orders.get();
    if (!snapshot) throw new TwapUnavailableError();
    return status === 'active'
      ? { orders: snapshot.orders.filter(isActiveTwap), lastUpdate: snapshot.lastUpdate }
      : snapshot;
  }

  private async fetchOrders(): Promise<TwapOrdersSnapshot> {
    try {
      const [orders, spotRaw, perpRaw, metas] = await Promise.all([
        this.twapClient.getRecentOrders(),
        redisService.get('spot:markets'),
        redisService.get('perp:markets'),
        // A missing HIP-3 name falls back to "Token N", as the front did.
        this.perpMetas.get().catch(() => null),
      ]);
      if (!Array.isArray(orders)) throw new Error('Unexpected /twap/* payload');
      // The front failed the whole fetch without the spot list, and fell back
      // to no perp names without the perp one.
      if (!spotRaw) throw new Error('No spot market data in Redis');

      const spot = JSON.parse(spotRaw) as MarketData[];
      const perp = perpRaw ? (JSON.parse(perpRaw) as PerpMarketData[]) : [];
      return {
        orders: enrichTwapOrders(orders, spot, perp, metas ?? []),
        lastUpdate: Date.now(),
      };
    } catch (error) {
      logDeduplicator.error('Failed to build the TWAP orders snapshot', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
