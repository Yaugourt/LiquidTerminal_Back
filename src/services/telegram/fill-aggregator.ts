import { NormalizedFill, AggregatedFill } from '../../types/fill-alerts.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * FillAggregator
 *
 * Buffers individual fills by order id (`oid`) and emits ONE `AggregatedFill`
 * per order once no new fill for that order has arrived for `WINDOW_MS`.
 *
 * Why: a single order fragments into many fills on HypeDexer — measured on the
 * live feed, ~88% of spot orders and ~15% of perp orders are multi-fill, and
 * the fills are delivered across separate WS messages (esp. spot). Dispatching
 * per-fill would send N Telegram alerts for one order. The fragmentation is
 * near-instant (median span 0 ms), so a short debounce collapses it cleanly.
 */
export class FillAggregator {
  /** Flush an order once it has been idle (no new fill) for this long. */
  private static readonly WINDOW_MS = 2000;

  private readonly buffers = new Map<
    string,
    { fills: NormalizedFill[]; timer: NodeJS.Timeout }
  >();

  constructor(private readonly onFlush: (agg: AggregatedFill) => void) {}

  /**
   * Add a fill to its order's buffer, (re)starting the debounce timer.
   */
  add(fill: NormalizedFill): void {
    const key = `${fill.source}:${fill.oid}`;
    const existing = this.buffers.get(key);

    if (existing) {
      existing.fills.push(fill);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(key), FillAggregator.WINDOW_MS);
      return;
    }

    const timer = setTimeout(() => this.flush(key), FillAggregator.WINDOW_MS);
    this.buffers.set(key, { fills: [fill], timer });
  }

  /**
   * Drop all pending buffers without emitting (used on shutdown).
   */
  clear(): void {
    for (const { timer } of this.buffers.values()) {
      clearTimeout(timer);
    }
    this.buffers.clear();
  }

  private flush(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.buffers.delete(key);

    try {
      this.onFlush(FillAggregator.aggregate(buffer.fills));
    } catch (error) {
      logDeduplicator.error('FillAggregator: flush callback error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Combine the fills of one order into a single AggregatedFill.
   * All fills of an `oid` share source/wallet/coin/side (verified against the
   * live feed) — only size, notional and price need combining.
   */
  private static aggregate(fills: NormalizedFill[]): AggregatedFill {
    const first = fills[0];

    let totalSz = 0;
    let totalNotional = 0;
    for (const f of fills) {
      totalSz += f.sz;
      totalNotional += f.notionalUsd;
    }
    // Volume-weighted average price; guard against a zero-size order.
    const vwap = totalSz > 0 ? totalNotional / totalSz : first.px;

    return {
      source: first.source,
      eventId: `${first.source}:${first.oid}:${first.wallet}`,
      oid: first.oid,
      wallet: first.wallet,
      coin: first.coin,
      side: first.side,
      px: vwap,
      sz: totalSz,
      notionalUsd: totalNotional,
      time: first.time,
      hash: first.hash,
      dir: first.dir,
      twapId: first.twapId ?? null,
      fillCount: fills.length,
    };
  }
}
