/**
 * Fill Alerts Types for LiquidTerminal
 *
 * Defines types for the HypeDexer WebSocket streams powering the Fill Telegram alert:
 * - perp fills → HypeDexer live-data `allFills` (/ws?mode=mirror)
 * - spot fills → HypeDexer multiplex `fills_spot` (/ws)
 *
 * Both raw shapes are normalized to a single `NormalizedFill` consumed by the dispatcher.
 */

// ============================================================================
// HYPEDEXER RAW TYPES — fills_spot (multiplex /ws)
// ============================================================================

/**
 * Raw spot fill from HypeDexer `fills_spot` WebSocket event.
 */
export interface HypeDexerSpotFill {
  user: string;
  coin: string;
  coin_meaning: string;
  px: number;
  sz: number;
  side: 'A' | 'B'; // A = sell, B = buy
  time: string;
  tid: number;
  oid: number;
  hash: string;
  fee: number;
  fee_token: string;
  fee_usdc: number;
  type_trade: string;
}

/**
 * HypeDexer `fills_spot` WebSocket event (server → client, multiplex endpoint).
 */
export interface HypeDexerSpotFillEvent {
  type: 'fills_spot';
  count: number;
  data: HypeDexerSpotFill[];
}

// ============================================================================
// HYPEDEXER RAW TYPES — allFills (live-data /ws?mode=mirror)
// ============================================================================

/**
 * Raw `fill` object from HypeDexer live-data `allFills` channel.
 */
export interface HypeDexerFill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B'; // A = sell, B = buy
  time: number; // epoch ms
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
  twapId?: number | null; // present on TWAP fills
  cloid?: string; // client order id, present on some fills
}

/**
 * One entry in an `allFills` event — a fill and the address it belongs to.
 */
export interface HypeDexerAllFillEntry {
  address: string;
  fill: HypeDexerFill;
}

/**
 * HypeDexer live-data `allFills` event (server → client). Discriminated by `channel`.
 * NOTE: `data` is an OBJECT — the fills array lives at `data.fills` (the OpenAPI
 * spec is wrong here). `isSnapshot` marks the one-shot historical burst sent on
 * subscribe, which must be skipped.
 */
export interface HypeDexerAllFillsEvent {
  channel: 'allFills';
  data: {
    isSnapshot?: boolean;
    fills: HypeDexerAllFillEntry[];
  };
}

// ============================================================================
// INTERNAL NORMALIZED TYPES
// ============================================================================

/**
 * Normalized spot fill — camelCase, numeric fields, user lowercase.
 */
export interface SpotFill {
  tid: number;
  oid: number;
  user: string; // Always lowercase
  coin: string; // coin_meaning || coin
  rawCoin: string;
  px: number;
  sz: number;
  notionalUsd: number; // px * sz
  side: 'A' | 'B'; // A = sell, B = buy
  time: string;
  hash: string;
  feeUsdc: number;
}

/**
 * Unified normalized fill — both perp (`allFills`) and spot (`fills_spot`) fills
 * are normalized to this shape. A single ORDER fragments into many fills sharing
 * one `oid`; the FillAggregator groups them into an `AggregatedFill`.
 */
export interface NormalizedFill {
  source: 'perp' | 'spot';
  oid: number; // Order id — aggregation key (all fills of one order share it)
  wallet: string; // Always lowercase
  coin: string;
  px: number;
  sz: number;
  notionalUsd: number; // px * sz
  side: 'A' | 'B'; // A = sell, B = buy
  time: string | number;
  hash: string;
  dir?: string; // Perp only — fill.dir
  twapId?: number | null; // Perp only — set when the fill belongs to a TWAP order
  closedPnl?: number; // Perp only — undefined on spot
}

/**
 * One order's fills aggregated into a single alert. Produced by the
 * FillAggregator after a per-`oid` debounce window. `fillCount` is the number
 * of individual fills that composed the order; `px` is volume-weighted.
 */
export interface AggregatedFill {
  source: 'perp' | 'spot';
  eventId: string; // `${source}:${oid}:${wallet}` — deduplication key
  oid: number;
  wallet: string; // Always lowercase
  coin: string;
  px: number; // Volume-weighted average price
  sz: number; // Total size across all fills
  notionalUsd: number; // Total notional across all fills
  side: 'A' | 'B'; // A = sell, B = buy
  time: string | number; // Earliest fill time
  hash: string;
  dir?: string; // Perp only
  twapId?: number | null; // Perp only — set when the order is a TWAP
  fillCount: number; // Number of fills aggregated (>= 1)
  /// Perp only — sum of closedPnl across aggregated fills. Undefined if no
  /// fill in the buffer carried a closedPnl (e.g. all spot, or all 0).
  closedPnlTotal?: number;
  /// Span between first and last fill in the buffer (ms). Undefined when
  /// only one fill was aggregated.
  aggregationDurationMs?: number;
}
