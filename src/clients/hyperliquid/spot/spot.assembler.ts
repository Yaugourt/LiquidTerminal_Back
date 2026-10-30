import { SpotContext, AssetContext, Market, Token, MarketData } from '../../../types/market.types';
import * as unitTokens from './unit.json';

/** What the spot poller derives from one (meta, contexts) pair. */
export interface SpotAssembly {
  markets: MarketData[];
  tokensWithoutPairs: string[];
}

/**
 * Turns Hyperliquid's `spotMetaAndAssetCtxs` into the rows served by
 * `/market/spot` and the list of tokens that have no pair.
 *
 * The one place that does it: the REST read and the socket-merged contexts both
 * come through here, so Redis gets the same shapes, in the same order, whichever
 * source fed it.
 *
 * @param reserveOf bridge reserve parked on a token's HyperEVM system address
 *   (0 for tokens without one), by tokenId
 */
export function assembleSpot(
  spotContext: SpotContext,
  assetContexts: AssetContext[],
  reserveOf: (tokenId: string) => number
): SpotAssembly {
  const tokenMap = spotContext.tokens.reduce((acc, token) => {
    acc[token.index] = token;
    return acc;
  }, {} as Record<number, Token>);

  // Indexed once instead of a linear `find` per market (first match wins, as before).
  const contextByCoin = new Map<string, AssetContext>();
  for (const ctx of assetContexts) {
    if (!contextByCoin.has(ctx.coin)) contextByCoin.set(ctx.coin, ctx);
  }

  const markets: MarketData[] = spotContext.universe.map((market: Market) => {
    const ctx = contextByCoin.get(market.name);
    if (!ctx) return null;

    const tokenIndex = market.tokens[0];
    const token = tokenMap[tokenIndex];
    if (!token) return null;

    const current = Number(ctx.markPx);
    const previous = Number(ctx.prevDayPx);
    const change = previous !== 0 ? Number((((current - previous) / previous) * 100).toFixed(2)) : 0;

    const displayName = unitTokens[token.name as keyof typeof unitTokens] || token.name;
    const logoName = displayName;

    // Hyperliquid counts the bridge reserve parked on a token's HyperEVM
    // system address as circulating (XAUT0 at $770,000B).
    const circulating = Number(ctx.circulatingSupply);
    const bridgeReserve = Math.min(reserveOf(token.tokenId), circulating);
    const supply = circulating - bridgeReserve;

    return {
      name: displayName,
      logo: `https://app.hyperliquid.xyz/coins/${logoName}_USDC.svg`,
      price: current,
      marketCap: current * supply,
      volume: Number(ctx.dayNtlVlm),
      change24h: change,
      liquidity: Number(ctx.midPx),
      supply,
      marketIndex: market.index,
      tokenId: token.tokenId,
      // Not always USDC: 17 of the 330 pairs were quoted in USDH, USDT0 or USDE on 2026-10-09.
      quote: tokenMap[market.tokens[1]]?.name ?? 'USDC',
      ...(bridgeReserve > 0 ? { bridgeReserve } : {}),
    };
  }).filter(Boolean) as MarketData[];

  // Trier les marchés par volume décroissant
  markets.sort((a, b) => b.volume - a.volume);

  const pairedTokens = new Set(spotContext.universe.map((market) => market.tokens[0]));
  const tokensWithoutPairs = spotContext.tokens
    .filter(token => !pairedTokens.has(token.index))
    .map(token => token.name);

  return { markets, tokensWithoutPairs };
}
