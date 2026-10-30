import { logDeduplicator } from './logDeduplicator';

/**
 * What this backend spends of Hyperliquid's 1,200 weight a minute per IP, by
 * request type: every request sent to api.hyperliquid.xyz/info or
 * api-ui.hyperliquid.xyz/info is counted with the documented weight of its
 * type. One summary line a minute (total and top types), and the last
 * minute's total for /api/health.
 *
 * - Weight 2: l2Book, allMids, clearinghouseState, orderStatus,
 *   spotClearinghouseState, exchangeStatus. Weight 60: userRole. Weight 20:
 *   every other type (an unknown type too).
 * - Per-item extras (+1 per 20 items returned; candleSnapshot +1 per 60) are
 *   added only where the response is parsed here, i.e. for the requests sent
 *   through BaseApiService. The raw fetches (HIP-4 reads, the ledger fallback)
 *   return small or fixed answers of types without extras, so they are
 *   counted at their base weight. userNonFundingLedgerUpdates is counted at
 *   20 without extras (a handful of rows).
 * - Requests are counted when sent, answered or not: a 429 spends weight too.
 * - Hyperliquid's WebSocket and stats-data.hyperliquid.xyz are not part of
 *   this budget and are not counted.
 *
 * Never throws and never waits: a Map increment per request.
 */

const LIGHT_TYPES: ReadonlySet<string> = new Set([
  'l2Book',
  'allMids',
  'clearinghouseState',
  'orderStatus',
  'spotClearinghouseState',
  'exchangeStatus',
]);
const DEFAULT_WEIGHT = 20;
const LIGHT_WEIGHT = 2;
const USER_ROLE_WEIGHT = 60;

/** Types whose weight grows by 1 per 20 items in the answer. */
const PER_20_ITEMS: ReadonlySet<string> = new Set([
  'recentTrades',
  'historicalOrders',
  'userFills',
  'userFillsByTime',
  'fundingHistory',
  'userFunding',
  'nonUserFundingUpdates',
  'twapHistory',
  'userTwapSliceFills',
  'userTwapSliceFillsByTime',
  'delegatorHistory',
]);
/** candleSnapshot grows by 1 per 60 candles. */
const PER_60_ITEMS: ReadonlySet<string> = new Set(['candleSnapshot']);

const FLUSH_INTERVAL_MS = 60_000;
const TOP_TYPES_LOGGED = 8;
/** A minute above this is logged as a warning: Hyperliquid starts answering 429 at 1,200. */
const WARN_WEIGHT = 1_000;
/** Upper bound on distinct types kept in a window, so a garbage `type` can't grow the map. */
const MAX_TYPES = 64;

/** Documented base weight of an info request type. */
export function hyperliquidWeight(type: string | undefined): number {
  if (type === 'userRole') return USER_ROLE_WEIGHT;
  if (type !== undefined && LIGHT_TYPES.has(type)) return LIGHT_WEIGHT;
  return DEFAULT_WEIGHT;
}

const TYPE_PATTERN = /"type"\s*:\s*"([A-Za-z0-9_]{1,64})"/;

/** The `type` of a JSON info request body, or undefined when it can't be read. */
export function infoRequestType(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  return TYPE_PATTERN.exec(body)?.[1];
}

interface TypeSpend {
  calls: number;
  weight: number;
}

export interface WeightMinute {
  /** Weight counted in that minute. */
  weight: number;
  calls: number;
  /** Epoch ms the minute ended. */
  endedAt: number;
}

export class HyperliquidWeightMeter {
  private perType = new Map<string, TypeSpend>();
  private timer: NodeJS.Timeout | null = null;
  private last: WeightMinute | null = null;

  /**
   * Count one request sent to Hyperliquid. `bodyOrType` is the JSON body that
   * goes out, or the bare type. Returns the type counted (undefined when it
   * can't be read: still counted, at the default weight, as 'unknown').
   */
  record(bodyOrType: unknown): string | undefined {
    try {
      const type = typeof bodyOrType === 'string' && !bodyOrType.startsWith('{') ? bodyOrType : infoRequestType(bodyOrType);
      this.add(type ?? 'unknown', hyperliquidWeight(type), 1);
      this.ensureTimer();
      return type;
    } catch {
      return undefined;
    }
  }

  /** Add the per-item extra of a parsed answer (a no-op for types without one). */
  recordItems(type: string | undefined, answer: unknown): void {
    try {
      if (!type || !Array.isArray(answer)) return;
      const extra = PER_20_ITEMS.has(type)
        ? Math.floor(answer.length / 20)
        : PER_60_ITEMS.has(type)
          ? Math.floor(answer.length / 60)
          : 0;
      if (extra > 0) this.add(type, extra, 0);
    } catch {
      // never throws
    }
  }

  private add(type: string, weight: number, calls: number): void {
    let key = type;
    if (!this.perType.has(key) && this.perType.size >= MAX_TYPES) key = 'other';
    const spend = this.perType.get(key) ?? { calls: 0, weight: 0 };
    spend.calls += calls;
    spend.weight += weight;
    this.perType.set(key, spend);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Close the minute: log its summary, keep its total, start the next. */
  flush(): void {
    try {
      const entries = [...this.perType.entries()].sort((a, b) => b[1].weight - a[1].weight);
      this.perType = new Map();
      let weight = 0;
      let calls = 0;
      for (const [, s] of entries) {
        weight += s.weight;
        calls += s.calls;
      }
      this.last = { weight, calls, endedAt: Date.now() };
      if (calls === 0) return;
      const fields = {
        weight,
        calls,
        limit: 1200,
        topTypes: entries.slice(0, TOP_TYPES_LOGGED).map(([type, s]) => `${type} ${s.weight}/${s.calls}`),
      };
      // The minute is in the text: the logger folds a repeated level+message
      // within 60 s, and a steady weight would read the same every minute.
      const minute = new Date(this.last.endedAt).toISOString().slice(11, 16);
      const message = `Hyperliquid weight ${weight} of 1,200, minute ending ${minute} UTC`;
      if (weight >= WARN_WEIGHT) logDeduplicator.warn(`${message}: near the limit`, fields);
      else logDeduplicator.info(message, fields);
    } catch {
      // never throws
    }
  }

  /** The last finished minute, or null before the first one. */
  lastMinute(): WeightMinute | null {
    return this.last;
  }

  /** Weight counted so far in the minute that is still running. */
  runningWeight(): number {
    let weight = 0;
    for (const spend of this.perType.values()) weight += spend.weight;
    return weight;
  }

  /** Test helper: stop the timer and forget everything. */
  reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.perType = new Map();
    this.last = null;
  }
}

export const hyperliquidWeightMeter = new HyperliquidWeightMeter();
