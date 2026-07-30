import { PriorityFeesBucket, PriorityFeesWindow } from '../../types/priorityFees.types';

/** Widest lookback `/analytics/priority-fees/stats` accepts. */
export const UPSTREAM_MAX_WINDOW_HOURS = 168;

const HOUR_SECONDS = 3_600;

/** Bucket width per window, in seconds. */
export const BUCKET_SECONDS: Record<PriorityFeesWindow, number> = {
  '24h': HOUR_SECONDS,
  '7d': 6 * HOUR_SECONDS,
};

/**
 * A single `/analytics/priority-fees/stats?hours=h` answer, normalized.
 *
 * The upstream reports cumulatively: every rollup starts `hours` ago and ends
 * now, so a wider window always contains a narrower one.
 */
export interface CumulativeRollup {
  hours: number;
  startMs: number;
  endMs: number;
  gas: number;
  fills: number;
}

/**
 * Lookback values to ask the upstream for, so that differencing consecutive
 * answers yields one bucket each.
 *
 * The ladder is capped at 168 h because that is the widest rollup the upstream
 * serves. A longer history would have to come from
 * `/analytics/priority-fees/chart/daily`, which stopped advancing on
 * 2026-07-11.
 */
export function bucketLadder(window: PriorityFeesWindow): number[] {
  const step = BUCKET_SECONDS[window] / HOUR_SECONDS;
  const span = window === '24h' ? 24 : UPSTREAM_MAX_WINDOW_HOURS;
  const hours: number[] = [];
  for (let h = step; h <= span; h += step) hours.push(h);
  return hours;
}

/**
 * Turn cumulative rollups into disjoint buckets by differencing neighbours.
 *
 * The narrowest rollup is a bucket on its own; every wider one contributes the
 * slice it adds over its predecessor. Buckets carry the span they actually
 * cover rather than the nominal width, so a rollup the upstream failed to
 * answer for widens its successor instead of silently shifting every bucket
 * that follows onto the wrong hour.
 *
 * Returned oldest first, which is the order a chart reads.
 */
export function computeBuckets(rollups: CumulativeRollup[]): PriorityFeesBucket[] {
  const usable = rollups
    .filter(
      (r) =>
        Number.isFinite(r.hours) &&
        r.hours > 0 &&
        Number.isFinite(r.startMs) &&
        Number.isFinite(r.endMs) &&
        r.startMs < r.endMs &&
        Number.isFinite(r.gas) &&
        Number.isFinite(r.fills)
    )
    .sort((a, b) => a.hours - b.hours);

  const buckets: PriorityFeesBucket[] = [];
  let previous: CumulativeRollup | null = null;

  for (const rollup of usable) {
    if (previous === null) {
      buckets.push({
        start: rollup.startMs,
        end: rollup.endMs,
        gas: Math.max(0, rollup.gas),
        fills: Math.max(0, rollup.fills),
      });
      previous = rollup;
      continue;
    }

    // Same lookback twice, or a wider window that somehow starts later: neither
    // describes a slice, so there is nothing to add.
    if (rollup.hours === previous.hours || rollup.startMs >= previous.startMs) continue;

    // Consecutive calls end a few seconds apart, so a near-empty slice can come
    // out slightly negative. That is drift, not a refund.
    buckets.push({
      start: rollup.startMs,
      end: previous.startMs,
      gas: Math.max(0, rollup.gas - previous.gas),
      fills: Math.max(0, rollup.fills - previous.fills),
    });
    previous = rollup;
  }

  return buckets.sort((a, b) => a.start - b.start);
}
