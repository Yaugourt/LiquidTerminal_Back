/**
 * Revenue breakdown types — daily 6-source decomposition of Hyperliquid protocol revenue.
 *
 * Sources:
 *   - perp:     Perp trading fees (USDC). From Hypurrscan /fees diff (total - spot).
 *   - spot:     Spot trading fees (USDC), GROSS user (C1). From Hypurrscan /fees spot diff × 2.
 *               The ×2 accounts for the 50/50 deployer split applied by HIP-1 token deployers.
 *               Approximation: ignores per-token `deployerTradingFeeShare` variations (e.g. USDC=0).
 *   - hip1:     Spot listing auction proceeds (USDC). Sum of |deployGas| from /pastAuctions.
 *   - hip3:     Perp DEX auction proceeds (HYPE × USD). Closed auctions × HYPE price.
 *   - hip4:     Prediction-market fees. 0 until mainnet launch.
 *   - priority: HyperCore ORDER priority fees (HYPE × USD) — not HyperEVM, and not all of
 *               priority. Up to 8 bps of notional charged from undelegated staking balance
 *               on filled notional (IOC) or resting notional (ALO), burned whether or not
 *               the order fills. 100% burned, so it counts as protocol-captured value.
 *               HypeDexer caps history to ~42 days, older days fall back to 0.
 *
 *               NOT included: gossip priority, the second HyperCore burn — two Dutch
 *               auctions on a three-minute cycle selling faster market-data reads, charged
 *               from spot balance, each resetting at 10x its last winning bid with a
 *               0.1 HYPE floor. It is served by /hip3/priority-fees/gossip/* whose feed has
 *               been frozen since 2026-07-11, so it cannot be added until that is fixed.
 *               Also not included: HyperEVM priority fees, a third and unrelated stream.
 *               @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/priority-fees
 */

export type RevenueWindow = '7d' | '30d' | '90d' | '1y' | 'all';

export interface RevenueDay {
  date: string;
  perp: number;
  spot: number;
  hip1: number;
  hip3: number;
  hip4: number;
  priority: number;
  total: number;
}

export interface RevenueLifetime {
  perp: number;
  spot: number;
  hip1: number;
  hip3: number;
  hip4: number;
  priority: number;
  total: number;
}

export type RevenueSourceStatus = 'ok' | 'stale' | 'error' | 'not_yet_live';

/**
 * Newest UTC day each series actually populates. A frozen upstream feed keeps
 * answering 200 with a stale payload, which bucketing turns into zeros that are
 * indistinguishable from a quiet day, so the client needs the real end of each
 * series to stop drawing it there instead of down to the floor.
 */
export interface RevenueCoverage {
  perpSpot: string | null;
  priority: string | null;
}

export interface RevenueMeta {
  spotMultiplier: number;
  hypeUsd: number | null;
  lastUpdate: number;
  coverage: RevenueCoverage;
  sourceStatus: {
    perpSpot: RevenueSourceStatus;
    hip1: RevenueSourceStatus;
    hip3: RevenueSourceStatus;
    hip4: RevenueSourceStatus;
    priority: RevenueSourceStatus;
  };
}

export interface RevenueBreakdown {
  window: RevenueWindow;
  days: RevenueDay[];
  lifetime: RevenueLifetime;
  meta: RevenueMeta;
}

export class RevenueError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'REVENUE_ERROR'
  ) {
    super(message);
    this.name = 'RevenueError';
  }
}
