/**
 * Live TWAP types for LiquidTerminal
 *
 * Two layers:
 * - `TwapStatusEvent`: one event of HypeDexer's live-data `allTwapStatusUpdates`
 *   channel, parsed by the live-data client.
 * - `TwapLiveEntry` & co: the contract of the public `twap` channel of our own
 *   /ws server (the front is built against it: keep both in step).
 */

// ============================================================================
// HYPEDEXER RAW TYPES — allTwapStatusUpdates (live-data /ws?mode=mirror)
// ============================================================================

/**
 * One event as HypeDexer sends it. Numbers travel as strings in `state`.
 * `executedSz`/`executedNtl` are 0 on non-terminal events (`activated`, `waitingForTrigger`) and final on terminal ones.
 */
export interface HypeDexerTwapStatusRaw {
  twapId: number;
  status: string;
  time: number; // epoch ms of the event
  state: {
    coin: string;
    user: string;
    side: 'A' | 'B';
    sz: string;
    executedSz: string;
    executedNtl: string;
    minutes: number;
    reduceOnly: boolean;
    randomize: boolean;
    timestamp: number; // epoch ms — TWAP start
    stopPx?: string | null;
    trigger?: unknown;
  };
}

/**
 * `allTwapStatusUpdates` frame (server → client). The snapshot (once per
 * subscribe) carries `{ isSnapshot: true, events }`; live frames carry the
 * events array directly in `data`.
 */
export interface HypeDexerTwapStatusEvent {
  channel: 'allTwapStatusUpdates';
  data: HypeDexerTwapStatusRaw[] | { isSnapshot?: boolean; events: HypeDexerTwapStatusRaw[] };
}

// ============================================================================
// INTERNAL NORMALIZED TYPES
// ============================================================================

/**
 * A status event, validated and normalized: numbers parsed, address lowercased.
 * `status` is the raw HypeDexer string. Terminal (final) statuses are
 * 'finished', 'terminated', 'stopped', 'canceled', 'cancelled' and anything
 * starting with 'error'; every other one ('activated', 'waitingForTrigger',
 * an unknown one) is live: a later event wins by time and fills accumulate.
 * Only a terminal status is final: fills after it are ignored and the totals
 * come from its event.
 */
export interface TwapStatusEvent {
  twapId: number;
  status: string;
  time: number; // epoch ms of the event
  coin: string;
  user: string; // lowercase
  side: 'A' | 'B'; // A = sell, B = buy
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  reduceOnly: boolean;
  randomize: boolean;
  startTime: number; // epoch ms (state.timestamp)
  isSnapshot: boolean; // replayed on (re)subscribe: apply idempotently
}

// ============================================================================
// PUBLIC /ws CHANNEL "twap" CONTRACT
// ============================================================================

export interface TwapLiveEntry {
  twapId: number;
  // present when the TWAP is known from HypeDexer's status channel; absent on progress-only patches
  // A TWAP is sent only from its first fill (or its terminal event): never-filled ones stay off the wire.
  status?: string; // raw HypeDexer/REST vocabulary; terminal = finished, terminated, stopped, canceled, cancelled, error*; live = activated, waitingForTrigger, ...
  coin?: string; // 'BTC', 'xyz:GOLD', '@107', 'PURR/USDC', '#123'
  user?: string; // lowercase address
  side?: 'A' | 'B'; // B = buy, A = sell
  sz?: number;
  minutes?: number;
  reduceOnly?: boolean;
  randomize?: boolean;
  startTime?: number; // epoch ms (state.timestamp)
  statusAt?: number; // epoch ms of the latest status event applied
  executedSz: number; // executed so far (sum of slice fills, or the final total once ended)
  executedNtl: number; // USD notional executed so far
  fills: number; // fills seen
  lastFillAt: number | null; // epoch ms
  lastPx: number | null;
  exact: boolean; // executed amounts cover the whole TWAP (tracked since its start, or seeded)
}

/** HypeDexer socket state; `since` = start of the current connection. */
export interface TwapLiveUpstream {
  connected: boolean;
  since: number | null;
}

export interface TwapLiveSnapshot {
  entries: TwapLiveEntry[];
  upstream: TwapLiveUpstream;
  at: number;
}

/** A patch the client merges field-wise by twapId. */
export type TwapLivePatch = Partial<TwapLiveEntry> & { twapId: number };

export interface TwapLiveDelta {
  entries: TwapLivePatch[];
  removed: number[];
  upstream: TwapLiveUpstream;
  at: number;
}
