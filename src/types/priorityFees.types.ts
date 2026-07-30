/**
 * Priority-fee series types — an hourly view of the HyperCore **order priority**
 * burn, reconstructed from cumulative rollups.
 *
 * Hyperliquid runs two priority mechanisms, both on HyperCore and both burning
 * HYPE:
 *   - order priority (write): up to 8 bps of notional, charged from undelegated
 *     staking balance on filled notional (IOC) or resting notional (ALO), and
 *     deducted whether or not the order fills. That is what this series counts.
 *   - gossip priority (read): two Dutch auctions on a three-minute cycle selling
 *     faster market-data reads, charged from spot balance, each auction
 *     resetting at 10x its last winning bid with a 0.1 HYPE floor. Served by
 *     `/hip3/priority-fees/gossip/*`, whose feed has been frozen since
 *     2026-07-11, so it is absent here.
 *
 * HyperEVM priority fees are a third, unrelated stream and are not counted
 * either.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/priority-fees
 */

export type PriorityFeesWindow = '24h' | '7d';

export interface PriorityFeesBucket {
  /** Bucket start, unix milliseconds (UTC). */
  start: number;
  /** Bucket end, unix milliseconds (UTC). */
  end: number;
  /** HYPE burned inside the bucket. */
  gas: number;
  /** Fills that paid priority inside the bucket. */
  fills: number;
}

/**
 * Window-wide aggregates.
 *
 * These come from a single rollup rather than from summing buckets: `avgGas`,
 * `minGas`, `maxGas` and `uniqueUsers` are not additive, so differencing two
 * cumulative windows cannot produce them.
 */
export interface PriorityFeesTotals {
  gas: number;
  fills: number;
  uniqueUsers: number;
  avgGas: number;
  minGas: number;
  maxGas: number;
  /** Every fill on the venue in the same window, priority-paying or not. */
  allFills: number | null;
  /** Every trader on the venue in the same window. */
  allUsers: number | null;
}

export interface PriorityFeesSeries {
  window: PriorityFeesWindow;
  /** Nominal width of one bucket, in seconds. */
  bucketSeconds: number;
  /** Chronological, oldest first. */
  buckets: PriorityFeesBucket[];
  totals: PriorityFeesTotals;
  meta: {
    hypeUsd: number | null;
    generatedAt: number;
    /** Widest lookback the upstream rollup accepts, in hours. */
    maxWindowHours: number;
    /** Buckets the upstream failed to answer for and that were left out. */
    missingBuckets: number;
  };
}

export class PriorityFeesError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'PRIORITY_FEES_ERROR'
  ) {
    super(message);
    this.name = 'PriorityFeesError';
  }
}
