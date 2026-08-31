/**
 * L4 order book types.
 *
 * L4 is the per-order book: every resting order individually, with its `oid`
 * and the address that placed it. Hyperliquid's public `l2Book` websocket caps
 * out at 20 aggregated price levels per side; L4 carries the whole book
 * (~6 000 levels / ~12 000 orders on HYPE), which is what makes real depth,
 * order counts and maker attribution possible.
 *
 * Upstream types mirror HypeDexer's mirror channel `l4Book`; downstream types
 * are the compact shape we broadcast to browsers over our own `/ws`.
 */

// ============================================================================
// UPSTREAM — HypeDexer mirror channel `l4Book`
// ============================================================================

/** `B` = bid (buy), `A` = ask (sell) — same convention as Hyperliquid. */
export type L4Side = 'A' | 'B';

/** One resting order in an L4 snapshot. */
export interface HypeDexerL4Order {
  coin: string;
  oid: number;
  px: string;
  side: L4Side;
  sz: string;
  user: string;
}

/**
 * How a single order changed. Three variants observed upstream:
 * - `'remove'`               — order left the book (cancelled or fully filled)
 * - `{ new: { sz } }`        — order entered the book (or was replaced)
 * - `{ update: { newSz } }`  — resting order resized (partial fill)
 */
export type HypeDexerL4Diff =
  | 'remove'
  | { new: { sz: string } }
  | { update: { newSz: string } };

/** One entry of an `updates` frame. */
export interface HypeDexerL4OrderDiff {
  coin: string;
  oid: number;
  px: string;
  side: L4Side;
  user: string;
  raw_book_diff: HypeDexerL4Diff;
}

/** First frame after subscribing: the full book. `levels` is `[bids, asks]`. */
export interface HypeDexerL4SnapshotFrame {
  snapshot: {
    coin: string;
    levels: [HypeDexerL4Order[], HypeDexerL4Order[]];
  };
}

/** Every subsequent frame: incremental per-order diffs. */
export interface HypeDexerL4UpdatesFrame {
  updates: {
    coin: string;
    time: number;
    updates: HypeDexerL4OrderDiff[];
  };
}

export type HypeDexerL4Frame = HypeDexerL4SnapshotFrame | HypeDexerL4UpdatesFrame;

// ============================================================================
// DOWNSTREAM — what we broadcast on our own `/ws`
// ============================================================================

/**
 * One aggregated price level, as a tuple to keep the payload small:
 * `[price, size, orderCount, uniqueMakers]`.
 *
 * `size === 0` in a delta frame means "this level is gone" — the client drops it.
 */
export type L4BookLevel = [px: number, sz: number, orders: number, makers: number];

/**
 * Book-wide aggregates, computed over the ENTIRE book rather than the truncated
 * ladder we ship. This is the part L2 cannot give you at all: how much size is
 * actually resting behind the visible levels, and how many distinct makers it
 * belongs to.
 */
export interface L4BookTotals {
  bidSize: number;
  askSize: number;
  bidNotional: number;
  askNotional: number;
  bidOrders: number;
  askOrders: number;
  bidLevels: number;
  askLevels: number;
  /** Distinct addresses resting at least one order anywhere in the book. */
  makers: number;
}

/** Full ladder, sent on subscribe and after any upstream resync. */
export interface L4BookSnapshotPayload {
  coin: string;
  time: number;
  /** Best-first: bids descending, asks ascending. */
  bids: L4BookLevel[];
  asks: L4BookLevel[];
  totals: L4BookTotals;
  /** How many levels per side this ladder is capped at. */
  depth: number;
}

/** Only the levels that changed inside the shipped depth window. */
export interface L4BookDeltaPayload {
  coin: string;
  time: number;
  bids: L4BookLevel[];
  asks: L4BookLevel[];
  totals: L4BookTotals;
}

/** Emitted when the upstream book for a coin is unavailable (dead/delisted coin). */
export interface L4BookUnavailablePayload {
  coin: string;
  reason: 'no_book';
}

export type L4BookEvent =
  | { type: 'l4book_snapshot'; data: L4BookSnapshotPayload }
  | { type: 'l4book_delta'; data: L4BookDeltaPayload }
  | { type: 'l4book_unavailable'; data: L4BookUnavailablePayload };

/** Per-coin runtime stats, surfaced on the health route. */
export interface L4BookCoinStats {
  coin: string;
  subscribers: number;
  orders: number;
  levels: number;
  lastUpdate: number;
  hasSnapshot: boolean;
}
