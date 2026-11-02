import { RejectionGuard } from '../../../src/utils/rejectionGuard';

describe('RejectionGuard', () => {
  it('tolerates isolated rejections and only flags a storm past the threshold', () => {
    const g = new RejectionGuard(25, 60_000);
    let t = 1_000_000;
    // 25 within the window: still fine.
    for (let i = 0; i < 25; i++) {
      expect(g.record(t)).toBe(false);
      t += 100;
    }
    // The 26th within the same window is the storm.
    expect(g.record(t)).toBe(true);
  });

  it('drops events older than the window, so a slow trickle never trips it', () => {
    const g = new RejectionGuard(3, 1_000);
    expect(g.record(0)).toBe(false);
    expect(g.record(500)).toBe(false);
    expect(g.record(900)).toBe(false);
    // 2000ms is past the 1s window from the first three: they expire, no storm.
    expect(g.record(2000)).toBe(false);
    expect(g.record(2100)).toBe(false);
    expect(g.record(2200)).toBe(false);
    expect(g.record(2300)).toBe(true);
  });
});
