/**
 * A resting maker order fills in bursts minutes apart. Each burst is flushed on its
 * own; they used to share one dedup id (source:oid:wallet), so only the first burst
 * ever alerted for the next 24 h.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { FillAggregator } from '../../../src/services/telegram/fill-aggregator';
import type { AggregatedFill, NormalizedFill } from '../../../src/types/fill-alerts.types';

const fill = (time: number, sz = 1): NormalizedFill => ({
  source: 'perp', oid: 42, wallet: '0xabc', coin: 'BTC', px: 100, sz, notionalUsd: 100 * sz, side: 'B', time, hash: '0xh',
});

describe('FillAggregator event ids', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('gives each burst of the same order its own id, and the same burst the same id', () => {
    const out: AggregatedFill[] = [];
    const agg = new FillAggregator((a) => out.push(a));
    agg.add(fill(1_000));
    agg.add(fill(1_050, 2));
    jest.advanceTimersByTime(3_000);
    agg.add(fill(600_000)); // the resting order fills again 10 minutes later
    jest.advanceTimersByTime(3_000);
    agg.add(fill(1_000)); // the first fill delivered again
    jest.advanceTimersByTime(3_000);

    expect(out).toHaveLength(3);
    expect(out[0].fillCount).toBe(2);
    expect(out[1].eventId).not.toBe(out[0].eventId);
    expect(out[2].eventId).toBe(out[0].eventId);
  });
});
