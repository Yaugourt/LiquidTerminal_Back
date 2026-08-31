/**
 * Aggregate positioning types.
 *
 * "What is the smart-money cohort collectively long vs short right now, per
 * coin." Built by fanning out Hyperliquid `clearinghouseState` over the top
 * traders and summing each open position's notional by direction.
 */

/** One open perp position, as returned inside `clearinghouseState.assetPositions[].position`. */
export interface ClearinghousePosition {
  coin: string;
  /** Signed size: negative = short, positive = long. */
  szi: string;
  entryPx?: string;
  /** Absolute notional of the position, USD. */
  positionValue?: string;
  unrealizedPnl?: string;
}

/** Hyperliquid `clearinghouseState` response (only the fields we use). */
export interface ClearinghouseState {
  assetPositions?: Array<{ position: ClearinghousePosition }>;
  marginSummary?: {
    accountValue?: string;
    totalNtlPos?: string;
  };
}

/** Collective positioning of the cohort on a single coin. */
export interface CoinPositioning {
  coin: string;
  /** Sum of long position notionals, USD. */
  longNotional: number;
  /** Sum of short position notionals, USD. */
  shortNotional: number;
  /** longNotional - shortNotional. Positive = net long. */
  netNotional: number;
  /** Traders in the cohort holding a long here. */
  longCount: number;
  /** Traders in the cohort holding a short here. */
  shortCount: number;
  /** Distinct traders with any position on this coin. */
  traderCount: number;
}

/** Full aggregate positioning snapshot for the cohort. */
export interface AggregatePositioning {
  coins: CoinPositioning[];
  totals: {
    longNotional: number;
    shortNotional: number;
    netNotional: number;
    /** longNotional / (longNotional + shortNotional), 0..1. */
    longShare: number;
  };
  /** Cohort size actually scanned (addresses that answered). */
  tradersScanned: number;
  /** Cohort size requested (union of top-trader lists). */
  cohortSize: number;
  updatedAt: string;
}

/** One stored hourly point of the cohort's net bias, for the history chart. */
export interface PositioningHistoryPoint {
  /** Epoch ms of the hour bucket. */
  time: number;
  longNotional: number;
  shortNotional: number;
  netNotional: number;
  longShare: number;
}

/** Response envelope returned by the route. */
export interface AggregatePositioningResponse {
  success: true;
  data: AggregatePositioning;
  metadata: {
    cachedAt: string;
  };
}

/** Domain error for the aggregate positioning vertical. */
export class PositioningError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = 'POSITIONING_SERVICE_ERROR'
  ) {
    super(message);
    this.name = 'PositioningError';
  }
}
