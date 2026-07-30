import {
  BUCKET_SECONDS,
  CumulativeRollup,
  UPSTREAM_MAX_WINDOW_HOURS,
  bucketLadder,
  computeBuckets,
} from '../../../src/services/priorityFees/priorityFees.series';

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 6, 27, 16, 0, 0);

/**
 * Build the rollup the upstream would answer for `hours`, given a cumulative
 * total. Every rollup ends now and starts `hours` earlier, which is the whole
 * property the differencing relies on.
 */
function rollup(hours: number, gas: number, fills: number): CumulativeRollup {
  return { hours, startMs: NOW - hours * HOUR_MS, endMs: NOW, gas, fills };
}

describe('bucketLadder', () => {
  it('asks for every hour of the last day', () => {
    const ladder = bucketLadder('24h');
    expect(ladder).toHaveLength(24);
    expect(ladder[0]).toBe(1);
    expect(ladder[ladder.length - 1]).toBe(24);
  });

  it('steps the week in six-hour strides and stops at the upstream ceiling', () => {
    const ladder = bucketLadder('7d');
    expect(ladder[0]).toBe(6);
    expect(ladder[ladder.length - 1]).toBe(UPSTREAM_MAX_WINDOW_HOURS);
    expect(ladder).toHaveLength(28);
    expect(Math.max(...ladder)).toBeLessThanOrEqual(UPSTREAM_MAX_WINDOW_HOURS);
  });

  it('covers the window exactly, with no overlap between strides', () => {
    for (const window of ['24h', '7d'] as const) {
      const ladder = bucketLadder(window);
      const stride = BUCKET_SECONDS[window] / 3600;
      ladder.forEach((hours, i) => expect(hours).toBe(stride * (i + 1)));
    }
  });
});

describe('computeBuckets', () => {
  it('differences neighbouring rollups into one bucket each', () => {
    // 10 HYPE in the last hour, 25 cumulative over two, 40 over three.
    const buckets = computeBuckets([rollup(1, 10, 100), rollup(2, 25, 260), rollup(3, 40, 400)]);

    expect(buckets).toHaveLength(3);
    expect(buckets.map((b) => b.gas)).toEqual([15, 15, 10]);
    expect(buckets.map((b) => b.fills)).toEqual([140, 160, 100]);
  });

  it('returns buckets oldest first', () => {
    const buckets = computeBuckets([rollup(3, 40, 400), rollup(1, 10, 100), rollup(2, 25, 260)]);
    const starts = buckets.map((b) => b.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('spans each bucket over the slice it really covers', () => {
    const buckets = computeBuckets([rollup(1, 10, 100), rollup(2, 25, 260)]);
    const newest = buckets[buckets.length - 1];
    expect(newest.end - newest.start).toBe(HOUR_MS);
    expect(newest.end).toBe(NOW);
  });

  it('widens the next bucket when a rollup is missing rather than shifting the rest', () => {
    // The 2 h call failed, so the 3 h answer covers two hours on its own.
    const buckets = computeBuckets([rollup(1, 10, 100), rollup(3, 40, 400)]);

    expect(buckets).toHaveLength(2);
    const older = buckets[0];
    expect(older.end - older.start).toBe(2 * HOUR_MS);
    expect(older.gas).toBe(30);
    // The hour that did answer keeps its own boundaries.
    expect(buckets[1].end - buckets[1].start).toBe(HOUR_MS);
  });

  it('reads a near-empty slice as zero, not as a refund', () => {
    // Consecutive calls end seconds apart, so a quiet hour can difference negative.
    const buckets = computeBuckets([rollup(1, 10.0001, 100), rollup(2, 10.0, 99)]);
    const oldest = buckets[0];
    expect(oldest.gas).toBe(0);
    expect(oldest.fills).toBe(0);
  });

  it('keeps the total across buckets equal to the widest rollup', () => {
    const rollups = [rollup(1, 10, 100), rollup(2, 25, 260), rollup(3, 40, 400), rollup(4, 44, 430)];
    const buckets = computeBuckets(rollups);

    const summed = buckets.reduce((acc, b) => acc + b.gas, 0);
    expect(summed).toBeCloseTo(44, 8);
    expect(buckets.reduce((acc, b) => acc + b.fills, 0)).toBe(430);
  });

  it('ignores a duplicated lookback instead of emitting an empty bucket', () => {
    const buckets = computeBuckets([rollup(1, 10, 100), rollup(1, 10, 100), rollup(2, 25, 260)]);
    expect(buckets).toHaveLength(2);
  });

  it('drops malformed rollups', () => {
    const buckets = computeBuckets([
      rollup(1, 10, 100),
      { hours: 2, startMs: NaN, endMs: NOW, gas: 25, fills: 260 },
      { hours: 3, startMs: NOW - 3 * HOUR_MS, endMs: NOW, gas: Number.NaN, fills: 400 },
      rollup(4, 44, 430),
    ]);

    expect(buckets).toHaveLength(2);
    expect(buckets.reduce((acc, b) => acc + b.gas, 0)).toBe(44);
  });

  it('returns nothing when no rollup is usable', () => {
    expect(computeBuckets([])).toEqual([]);
    expect(computeBuckets([{ hours: 0, startMs: NOW, endMs: NOW, gas: 1, fills: 1 }])).toEqual([]);
  });

  it('never emits a bucket that ends before it starts', () => {
    const buckets = computeBuckets([rollup(1, 10, 100), rollup(2, 25, 260), rollup(3, 40, 400)]);
    buckets.forEach((b) => expect(b.end).toBeGreaterThan(b.start));
  });
});
