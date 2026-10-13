/** One order of Hypurrscan's `/twap/*` dump (the last ~24 h of TWAP orders). */
export interface RawTwapOrder {
  time: number;
  user: string;
  action: {
    type: 'twapOrder';
    twap: {
      /** Asset index: perp < 10000, spot = 10000 + pair index, HIP-3 = 100000 + perp dex index × 10000 + local index. */
      a: number;
      b: boolean;
      s: string;
      r: boolean;
      m: number;
      t: boolean;
    };
  };
  block: number;
  hash: string;
  error: string | null;
  ended?: string | null;
}

export type TwapMarketType = 'spot' | 'perp' | 'hip3';

export interface TwapOrderWithMarket extends RawTwapOrder {
  tokenSymbol: string;
  /** Current price of the market, 0 when unknown (HIP-3 markets have none here). */
  tokenPrice: number;
  /** `a` minus the spot offset (10000) for spot/HIP-3, `a` itself for perps. */
  marketIndex: number;
  marketType: TwapMarketType;
}

export interface TwapSpotMarket {
  name: string;
  price: number;
  marketIndex: number;
}

export interface TwapPerpMarket {
  name: string;
  price: number;
  index: number;
}

/** Hyperliquid `allPerpMetas`: one entry per perp dex, slot 0 = native perps. */
export type AllPerpMetas = Array<{ universe?: Array<{ name: string }> } | null>;

export const isActiveTwap = (order: RawTwapOrder): boolean => !order.ended && !order.error;

/**
 * Resolves each order's market (name, price, family) — the enrichment the
 * front used to run in every browser after downloading the dump, the spot and
 * perp lists and `allPerpMetas`. Same rules: spot pair > native perp > HIP-3
 * name > `Token N`, and `USDT_USDC` shown as `USDT0`.
 */
export function enrichTwapOrders(
  orders: RawTwapOrder[],
  spotMarkets: TwapSpotMarket[],
  perpMarkets: TwapPerpMarket[],
  allPerpMetas: AllPerpMetas
): TwapOrderWithMarket[] {
  const spotByIndex = new Map<number, TwapSpotMarket>();
  for (const market of spotMarkets) spotByIndex.set(market.marketIndex, market);

  const perpByIndex = new Map<number, TwapPerpMarket>();
  for (const market of perpMarkets) perpByIndex.set(market.index, market);

  // HIP-3 dex slot (1+) → local asset names ("xyz:XYZ100" → "XYZ100").
  const hip3Universes = new Map<number, string[]>();
  allPerpMetas.forEach((dex, slot) => {
    if (!dex || slot === 0) return;
    hip3Universes.set(
      slot,
      (dex.universe ?? []).map((asset) => {
        const parts = asset.name.split(':');
        return parts.length > 1 ? parts[1] : asset.name;
      })
    );
  });

  return orders
    .filter((order) => order.action?.twap?.a >= 0)
    .map((order) => {
      const assetIndex = order.action.twap.a;
      const isHip3 = assetIndex >= 100000;
      const isSpot = !isHip3 && assetIndex >= 10000;
      const marketIndex = assetIndex >= 10000 ? assetIndex - 10000 : assetIndex;

      const spot = isSpot ? spotByIndex.get(marketIndex) : undefined;
      const perp = !isSpot && !isHip3 ? perpByIndex.get(marketIndex) : undefined;
      // HIP-3: a = 100000 + dex × 10000 + local index (dex 1 = xyz).
      const hip3Name = isHip3
        ? (hip3Universes.get(Math.floor((assetIndex - 100000) / 10000))?.[(assetIndex - 100000) % 10000] ?? null)
        : null;

      let tokenSymbol = spot?.name || perp?.name || hip3Name || `Token ${marketIndex}`;
      if (tokenSymbol === 'USDT_USDC') tokenSymbol = 'USDT0';

      const marketType: TwapMarketType = isHip3 ? 'hip3' : isSpot ? 'spot' : 'perp';

      return {
        ...order,
        tokenSymbol,
        tokenPrice: spot?.price || perp?.price || 0,
        marketIndex,
        marketType,
      };
    });
}
