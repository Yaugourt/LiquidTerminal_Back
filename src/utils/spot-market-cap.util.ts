import type { MarketData } from '../types/market.types';

/**
 * Total market cap of the spot market, each base token counted once.
 *
 * A market row is a pair, and every pair of a token carries the token's whole
 * market cap (price × supply): HYPE trades against USDC, USDT0, USDH and USDE,
 * so adding up the rows counted it four times. Rows are grouped by `tokenId`;
 * the USDC pair is the canonical price (the largest if there are several),
 * and a token with no USDC pair takes its largest pair.
 */
export function totalMarketCapPerToken(markets: readonly MarketData[]): number {
  const usdc = new Map<string, number>();
  const largest = new Map<string, number>();

  for (const market of markets) {
    // A row without a token id is its own token rather than every such row's.
    const key = market.tokenId || `pair:${market.name}`;
    const cap = Number.isFinite(market.marketCap) ? market.marketCap : 0;
    largest.set(key, Math.max(largest.get(key) ?? 0, cap));
    if (market.quote === 'USDC') usdc.set(key, Math.max(usdc.get(key) ?? 0, cap));
  }

  let total = 0;
  for (const [key, cap] of largest) total += usdc.get(key) ?? cap;
  return total;
}
