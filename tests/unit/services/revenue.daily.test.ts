import {
  MAX_INTERPOLATION_GAP_SECONDS,
  SECONDS_PER_DAY,
  computePerpSpotDaily,
  lastPopulatedDate,
} from '../../../src/services/revenue/revenue.daily';
import { FeeData } from '../../../src/types/fees.types';

const MICRO = 1_000_000;

/** Seconds since epoch for a UTC wall-clock time. */
function at(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/**
 * A cumulative point. `total` and `spot` are plain dollars here and scaled to
 * the micro-USD the upstream actually publishes, so the fixtures stay readable.
 */
function point(iso: string, total: number, spot: number): FeeData {
  return { time: at(iso), total_fees: total * MICRO, total_spot_fees: spot * MICRO } as FeeData;
}

/**
 * The upstream cadence: one point a day just before midnight, each adding
 * `perDay` of protocol fees of which `spotPerDay` is spot.
 */
function dailySeries(
  days: number,
  { perDay = 1_400_000, spotPerDay = 20_000, clock = 'T23:51:00Z' } = {}
): FeeData[] {
  const out: FeeData[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
    out.push(point(`${day}${clock}`, perDay * (i + 1), spotPerDay * (i + 1)));
  }
  return out;
}

describe('computePerpSpotDaily', () => {
  it('reads a steady 24h cadence as flat days', () => {
    const { daily } = computePerpSpotDaily(dailySeries(6));

    for (const [, value] of daily) {
      expect(value.perp).toBeCloseTo(1_380_000, 0);
      expect(value.spot).toBeCloseTo(40_000, 0); // 20k protocol share, doubled
    }
  });

  it('never emits the running day', () => {
    const fees = dailySeries(5);
    const { daily, coverageThrough } = computePerpSpotDaily(fees);

    // Points run 2026-06-01..05 at 23:51. The last closed midnight is 06-05
    // 00:00, so 06-05 itself is still open and must not appear.
    expect(coverageThrough).toBe('2026-06-04');
    expect(daily.has('2026-06-05')).toBe(false);
  });

  it('does not emit a partial day when the newest point is intraday', () => {
    // The exact prod failure: a cached snapshot whose newest point sits an hour
    // into the day. Diffing raw points filed 2026-06-06 under one hour of fees.
    const fees = [...dailySeries(5), point('2026-06-06T01:00:00Z', 7_058_000, 100_800)];
    const { daily, coverageThrough } = computePerpSpotDaily(fees);

    expect(daily.has('2026-06-06')).toBe(false);
    expect(coverageThrough).toBe('2026-06-05');
    // 06-05 is now a whole day, not the sliver between 06-05T23:51 and midnight.
    expect(daily.get('2026-06-05')!.perp).toBeGreaterThan(1_000_000);
  });

  it('splits a late point across the days it really spans', () => {
    // 06-03's point slips to 06-04T07:00, so the raw diff would starve 06-03
    // and stuff 31h of fees into 06-04.
    const fees = [
      point('2026-06-01T23:51:00Z', 1_400_000, 20_000),
      point('2026-06-02T23:51:00Z', 2_800_000, 40_000),
      point('2026-06-04T07:00:00Z', 4_760_000, 68_000),
      point('2026-06-04T23:51:00Z', 5_600_000, 80_000),
      point('2026-06-05T23:51:00Z', 7_000_000, 100_000),
    ];
    const { daily } = computePerpSpotDaily(fees);

    // Both days land near the true run rate instead of one starving the other,
    // and together they still account for the two days of fees that accrued.
    const spanned = daily.get('2026-06-03')!.perp + daily.get('2026-06-04')!.perp;
    expect(daily.get('2026-06-03')!.perp).toBeGreaterThan(1_000_000);
    expect(daily.get('2026-06-04')!.perp).toBeGreaterThan(1_000_000);
    expect(Math.abs(spanned - 2_760_000) / 2_760_000).toBeLessThan(0.01);
  });

  it('leaves out the days inside a gap too wide to interpolate', () => {
    const gapDays = MAX_INTERPOLATION_GAP_SECONDS / SECONDS_PER_DAY + 3;
    const resumeAt = new Date(Date.UTC(2026, 5, 2 + gapDays)).toISOString().slice(0, 10);
    const fees = [
      point('2026-06-01T23:51:00Z', 1_400_000, 20_000),
      point('2026-06-02T23:51:00Z', 2_800_000, 40_000),
      point(`${resumeAt}T23:51:00Z`, 30_000_000, 400_000),
    ];
    const { daily } = computePerpSpotDaily(fees);

    // The outage is absent, not dumped onto one record-breaking day.
    expect(daily.has('2026-06-03')).toBe(false);
    for (const [, value] of daily) {
      expect(value.perp).toBeLessThan(5_000_000);
    }
  });

  it('holds the line against a counter that goes backwards', () => {
    const fees = [
      point('2026-06-01T23:51:00Z', 1_400_000, 20_000),
      point('2026-06-02T23:51:00Z', 2_800_000, 40_000),
      point('2026-06-03T23:51:00Z', 2_000_000, 30_000),
      point('2026-06-04T23:51:00Z', 4_200_000, 60_000),
    ];
    const { daily } = computePerpSpotDaily(fees);

    for (const [, value] of daily) {
      expect(value.perp).toBeGreaterThanOrEqual(0);
      expect(value.spot).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns nothing usable when the series cannot close a single day', () => {
    expect(computePerpSpotDaily([])).toEqual({ daily: new Map(), coverageThrough: null });
    expect(computePerpSpotDaily([point('2026-06-01T23:51:00Z', 1, 0)]).coverageThrough).toBeNull();

    const sameDay = [
      point('2026-06-01T08:00:00Z', 1_000_000, 10_000),
      point('2026-06-01T20:00:00Z', 1_200_000, 12_000),
    ];
    expect(computePerpSpotDaily(sameDay).coverageThrough).toBeNull();
  });

  it('ignores malformed points instead of poisoning the series', () => {
    const fees = [
      ...dailySeries(4),
      { time: NaN, total_fees: 1, total_spot_fees: 0 } as FeeData,
      { time: at('2026-06-03T12:00:00Z'), total_fees: NaN, total_spot_fees: 0 } as FeeData,
    ];
    const { daily } = computePerpSpotDaily(fees);

    expect(daily.size).toBeGreaterThan(0);
    for (const [, value] of daily) {
      expect(Number.isFinite(value.perp)).toBe(true);
      expect(Number.isFinite(value.spot)).toBe(true);
    }
  });
});

describe('lastPopulatedDate', () => {
  it('reports the newest day carrying a value', () => {
    const daily = new Map([
      ['2026-07-09', 50_515],
      ['2026-07-11', 2_860],
      ['2026-07-10', 46_665],
    ]);
    expect(lastPopulatedDate(daily)).toBe('2026-07-11');
  });

  it('sees through the zeros a frozen feed leaves behind', () => {
    // What prod actually served: the upstream job died on 2026-07-11 and every
    // day after it bucketed to a silent zero.
    const daily = new Map([
      ['2026-07-10', 46_665],
      ['2026-07-11', 2_860],
      ['2026-07-12', 0],
      ['2026-07-13', 0],
    ]);
    expect(lastPopulatedDate(daily)).toBe('2026-07-11');
  });

  it('returns null when nothing is populated at all', () => {
    expect(lastPopulatedDate(new Map())).toBeNull();
    expect(lastPopulatedDate(new Map([['2026-07-12', 0]]))).toBeNull();
  });
});
