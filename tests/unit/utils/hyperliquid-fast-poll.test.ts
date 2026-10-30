/**
 * Global stats, validators and HLP read faster while the backend's Hyperliquid
 * weight has room, and fall back to their former cadence when it does not.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { adaptiveReadGate, HL_FAST_POLL_MAX_WEIGHT } from '../../../src/clients/hyperliquid/fast-poll';
import { hyperliquidWeightMeter } from '../../../src/utils/hyperliquid-weight-meter';

/** Spend just over the threshold with weight-20 reads. */
function spendOverThreshold(): void {
  for (let w = 0; w <= HL_FAST_POLL_MAX_WEIGHT; w += 20) hyperliquidWeightMeter.record('metaAndAssetCtxs');
}

describe('adaptiveReadGate', () => {
  afterEach(() => hyperliquidWeightMeter.reset());

  it('reads on every tick while the weight has room', () => {
    let t = 0;
    const gate = adaptiveReadGate(15_000, () => t);
    expect(gate()).toBe(true);
    t += 5_000;
    expect(gate()).toBe(true);
    t += 5_000;
    expect(gate()).toBe(true);
  });

  it('keeps the slow cadence while the running minute is over the threshold', () => {
    let t = 0;
    const gate = adaptiveReadGate(15_000, () => t);
    expect(gate()).toBe(true);
    spendOverThreshold();
    t += 5_000;
    expect(gate()).toBe(false);
    t += 5_000;
    expect(gate()).toBe(false);
    t += 5_000; // 15 s since the last read
    expect(gate()).toBe(true);
  });

  it('also holds back after a heavy finished minute', () => {
    spendOverThreshold();
    hyperliquidWeightMeter.flush(); // the heavy minute is now the last one, the running one is empty
    expect(hyperliquidWeightMeter.runningWeight()).toBe(0);
    let t = 0;
    const gate = adaptiveReadGate(30_000, () => t);
    expect(gate()).toBe(true); // the first read is never held back
    t += 10_000;
    expect(gate()).toBe(false);
    t += 20_000;
    expect(gate()).toBe(true);
  });
});

describe('HyperliquidWeightMeter.runningWeight', () => {
  afterEach(() => hyperliquidWeightMeter.reset());

  it('sums the minute still running and restarts at each flush', () => {
    hyperliquidWeightMeter.record('allMids');
    hyperliquidWeightMeter.record('globalStats');
    expect(hyperliquidWeightMeter.runningWeight()).toBe(22);
    hyperliquidWeightMeter.flush();
    expect(hyperliquidWeightMeter.runningWeight()).toBe(0);
    expect(hyperliquidWeightMeter.lastMinute()?.weight).toBe(22);
  });
});
