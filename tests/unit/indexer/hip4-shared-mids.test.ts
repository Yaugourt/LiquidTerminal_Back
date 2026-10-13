/**
 * HIP-4 odds come from one shared Hyperliquid allMids read (weight 2): at
 * most one every 5 s whatever the number of enriched keys and visitors,
 * single-flight, served from the last map while a refresh runs, and a failed
 * read keeps the last good map instead of dropping every market's odds.
 */
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn(async () => null), set: jest.fn(), isHealthy: () => true },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { SharedHip4Mids } from '../../../src/services/indexer/indexer-hip4.service';

const mids = (px: number): Map<string, number> => new Map([['#10', px]]);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SharedHip4Mids', () => {
  let now: number;

  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads once for concurrent callers and reuses the map for 5 s', async () => {
    const read = jest.fn(async () => mids(0.5));
    const shared = new SharedHip4Mids(read);
    const all = await Promise.all(Array.from({ length: 20 }, () => shared.get()));
    expect(all.every((m) => m.get('#10') === 0.5)).toBe(true);
    now += 4_999;
    await shared.get();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('serves the last map while one refresh runs, then the new one', async () => {
    const read = jest.fn().mockResolvedValueOnce(mids(0.5)).mockResolvedValueOnce(mids(0.6));
    const shared = new SharedHip4Mids(read);
    await shared.get();
    now += 6_000;
    expect((await shared.get()).get('#10')).toBe(0.5);
    await flush();
    expect((await shared.get()).get('#10')).toBe(0.6);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good map when a read fails, and waits 5 s before the next try', async () => {
    const read = jest.fn().mockResolvedValueOnce(mids(0.5)).mockRejectedValue(new Error('timeout'));
    const shared = new SharedHip4Mids(read);
    await shared.get();
    // Past a minute the old map is not served at once: the caller waits for the read, which fails.
    now += 61_000;
    expect((await shared.get()).get('#10')).toBe(0.5);
    await shared.get();
    expect(read).toHaveBeenCalledTimes(2);
    now += 5_000;
    await shared.get();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('answers an empty map when the first read fails', async () => {
    const shared = new SharedHip4Mids(jest.fn().mockRejectedValue(new Error('down')));
    await expect(shared.get()).resolves.toEqual(new Map());
  });

  it('makes no new read within 5 s of a failed first read', async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce(mids(0.5));
    const shared = new SharedHip4Mids(read);
    await expect(shared.get()).resolves.toEqual(new Map());
    for (let i = 0; i < 10; i++) {
      now += 400;
      await expect(shared.get()).resolves.toEqual(new Map());
    }
    expect(read).toHaveBeenCalledTimes(1);
    now += 1_000; // 5.0 s after the failed read
    expect((await shared.get()).get('#10')).toBe(0.5);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares the in-flight first read with every caller', async () => {
    let resolve: (m: Map<string, number>) => void = () => undefined;
    const read = jest.fn(() => new Promise<Map<string, number>>((r) => { resolve = r; }));
    const shared = new SharedHip4Mids(read);
    const calls = Array.from({ length: 5 }, () => shared.get());
    resolve(mids(0.7));
    const all = await Promise.all(calls);
    expect(all.every((m) => m.get('#10') === 0.7)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
