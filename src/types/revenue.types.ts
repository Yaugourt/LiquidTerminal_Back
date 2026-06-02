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
 *   - priority: HyperEVM priority fees (HYPE × USD). 100% burned on-chain — counts as
 *               protocol-captured value (EIP-1559-style mechanism). HypeDexer caps history
 *               to ~42 days, older days fall back to 0.
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

export interface RevenueMeta {
  spotMultiplier: number;
  hypeUsd: number | null;
  lastUpdate: number;
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
