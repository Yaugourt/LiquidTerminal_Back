/**
 * Turning Hypurrscan's cumulative fee counter into daily revenue.
 *
 * Kept apart from RevenueService so it stays a pure function of its input: no
 * singleton, no Redis, no upstream clients, and therefore directly testable.
 */
import { FeeData } from '../../types/fees.types';

export const MICRO_USD_DIVISOR = 1_000_000;
export const SPOT_DEPLOYER_MULTIPLIER = 2;

export const SECONDS_PER_DAY = 86_400;

/**
 * Widest gap between two cumulative fee points we will interpolate a UTC
 * midnight across.
 *
 * The upstream series ticks every 24 h (median 24.00 h, p95 24.17 h) but has
 * gone dark for as long as sixteen days. Across such a gap the counter still
 * advanced, so the fees are real and only their day-by-day shape is unknown.
 * Spreading them linearly keeps the lifetime total exact and draws a flat
 * plateau that reads as the outage it was; the alternatives both lie, either
 * dumping sixteen days of fees onto one record-breaking day or claiming the
 * protocol earned nothing. Past a month the flat-rate assumption stops meaning
 * anything, so that is where we stop and leave the days out.
 */
export const MAX_INTERPOLATION_GAP_SECONDS = 30 * 24 * 3600;

/** Daily perp/spot buckets plus the newest UTC day they actually cover. */
export interface PerpSpotSeries {
  daily: Map<string, { perp: number; spot: number }>;
  coverageThrough: string | null;
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Convert a unix seconds timestamp to its UTC date key. */
export function secondsToDateKey(seconds: number): string {
  return utcDateKey(new Date(seconds * 1000));
}

/**
 * Compute daily perp & spot from the cumulative `/fees` series.
 *
 * Hypurrscan publishes one cumulative point per ~day, near 23:50 UTC. Diffing
 * consecutive points measures the interval between those two timestamps, not a
 * calendar day, so any point that lands early turns the day it is filed under
 * into a partial one. That is invisible in the middle of the series but fatal
 * at its tail: a snapshot whose newest point is intraday emits a day worth an
 * hour of fees, which reads as a collapse rather than as missing data.
 *
 * So we interpolate the counters onto UTC midnight and diff midnight to
 * midnight. Every emitted day is then a true UTC day, the running day is never
 * emitted (its closing boundary is in the future), an outage is spread over the
 * days it spans instead of landing on one, and boundaries inside a gap wider
 * than MAX_INTERPOLATION_GAP_SECONDS are skipped rather than guessed.
 * `coverageThrough` is the newest day that survived, which the caller uses to
 * stop the breakdown where its dominant source stops.
 *
 * spot is multiplied by SPOT_DEPLOYER_MULTIPLIER to reflect gross-user fees
 * (Hypurrscan stores the protocol share only — the deployer takes the other
 * half on HIP-1 spot pairs).
 */
export function computePerpSpotDaily(fees: FeeData[]): PerpSpotSeries {
  const points = fees
    .filter(
      (p) =>
        Number.isFinite(p.time) &&
        Number.isFinite(p.total_fees) &&
        Number.isFinite(p.total_spot_fees)
    )
    .sort((a, b) => a.time - b.time);

  const daily = new Map<string, { perp: number; spot: number }>();
  if (points.length < 2) return { daily, coverageThrough: null };

  const first = points[0].time;
  const last = points[points.length - 1].time;
  const firstBoundary = Math.ceil(first / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const lastBoundary = Math.floor(last / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  if (lastBoundary <= firstBoundary) return { daily, coverageThrough: null };

  // Read the counters at every UTC midnight the series brackets. `null` marks a
  // boundary sitting inside a gap too wide to interpolate.
  const atBoundary = new Map<number, { total: number; spot: number } | null>();
  let i = 1;
  for (let t = firstBoundary; t <= lastBoundary; t += SECONDS_PER_DAY) {
    while (i < points.length && points[i].time < t) i++;
    const prev = points[i - 1];
    const next = points[i];
    const span = next ? next.time - prev.time : Infinity;
    if (!next || span <= 0 || span > MAX_INTERPOLATION_GAP_SECONDS) {
      atBoundary.set(t, null);
      continue;
    }
    const fraction = (t - prev.time) / span;
    atBoundary.set(t, {
      total: prev.total_fees + (next.total_fees - prev.total_fees) * fraction,
      spot: prev.total_spot_fees + (next.total_spot_fees - prev.total_spot_fees) * fraction,
    });
  }

  let coverageThrough: string | null = null;
  for (let t = firstBoundary; t < lastBoundary; t += SECONDS_PER_DAY) {
    const open = atBoundary.get(t);
    const close = atBoundary.get(t + SECONDS_PER_DAY);
    if (!open || !close) continue;

    const totalDelta = (close.total - open.total) / MICRO_USD_DIVISOR;
    const spotProtocolDelta = (close.spot - open.spot) / MICRO_USD_DIVISOR;
    const date = secondsToDateKey(t);

    daily.set(date, {
      perp: Math.max(0, totalDelta - spotProtocolDelta),
      spot: Math.max(0, spotProtocolDelta * SPOT_DEPLOYER_MULTIPLIER),
    });
    coverageThrough = date;
  }

  return { daily, coverageThrough };
}

/** Newest key holding a strictly positive value, or null if there is none. */
export function lastPopulatedDate(daily: Map<string, number>): string | null {
  let latest: string | null = null;
  for (const [date, value] of daily) {
    if (value > 0 && (latest === null || date > latest)) latest = date;
  }
  return latest;
}
