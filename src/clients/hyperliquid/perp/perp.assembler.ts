import { PerpMarket, PerpAssetContext, PerpMarketData } from '../../../types/market.types';

/** Hyperliquid's `metaAndAssetCtxs`: the universe, and one context per perp by position. */
export type PerpMetaAndContexts = [{ universe: PerpMarket[] }, PerpAssetContext[]];

/**
 * Turns Hyperliquid's `metaAndAssetCtxs` into the rows served by `/market/perp`
 * (Redis `perp:markets`).
 *
 * The one place that does it: the REST read and the socket-merged contexts both
 * come through here, so Redis gets the same shapes, in the same order, whichever
 * source fed it. Contexts are matched to the universe by position.
 */
export function assemblePerp(
  meta: { universe: PerpMarket[] },
  assetContexts: PerpAssetContext[]
): Array<PerpMarketData & { logo: string }> {
  return meta.universe
    .map((market: PerpMarket, index: number) => {
      const assetContext = assetContexts[index];
      const currentPrice = Number(assetContext.markPx);
      const prevDayPrice = Number(assetContext.prevDayPx);
      const change = prevDayPrice !== 0 ? Number((((currentPrice - prevDayPrice) / prevDayPrice) * 100).toFixed(2)) : 0;
      const volume = Number(assetContext.dayNtlVlm);

      return {
        index: index,
        name: market.name,
        logo: `https://app.hyperliquid.xyz/coins/${market.name}.svg`,
        price: currentPrice,
        change24h: change,
        volume: volume,
        openInterest: Number(assetContext.openInterest),
        funding: Number(assetContext.funding),
        maxLeverage: market.maxLeverage,
        onlyIsolated: market.onlyIsolated || false
      };
    })
    .filter(market => market.volume > 0); // Filtrer les tokens avec un volume de 0
}
