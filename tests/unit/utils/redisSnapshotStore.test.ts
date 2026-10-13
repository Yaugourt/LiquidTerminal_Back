/**
 * redisSnapshotStore: an OnDemandSnapshot value and its fetch time in one
 * Redis key, plain or gzipped, with an optional encoding; anything unreadable
 * reads as nothing stored.
 */
const store = new Map<string, { value: string; ttl?: number }>();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn(async (key: string) => store.get(key)?.value ?? null),
    set: jest.fn(async (key: string, value: string, ttl?: number) => {
      store.set(key, { value, ttl });
    }),
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { redisSnapshotStore } from '../../../src/utils/redisSnapshotStore';

describe('redisSnapshotStore', () => {
  beforeEach(() => store.clear());

  it('round-trips a value and its fetch time under the given TTL', async () => {
    const s = redisSnapshotStore<{ a: number }>('k', { ttlS: 60 });
    await s.save({ a: 1 }, 1_000);
    expect(store.get('k')).toEqual({ value: '{"fetchedAt":1000,"value":{"a":1}}', ttl: 60 });
    await expect(s.load()).resolves.toEqual({ value: { a: 1 }, fetchedAt: 1_000 });
  });

  it('keeps the fetch time in a small sibling key, readable without the value', async () => {
    const s = redisSnapshotStore<{ a: number }>('k', { ttlS: 60, compress: true });
    await expect(s.loadFetchedAt?.()).resolves.toBeNull();
    await s.save({ a: 1 }, 1_000);
    expect(store.get('k:at')).toEqual({ value: '1000', ttl: 60 });
    await expect(s.loadFetchedAt?.()).resolves.toBe(1_000);
    store.set('k:at', { value: 'garbage' });
    await expect(s.loadFetchedAt?.()).resolves.toBeNull();
  });

  it('gzips when asked, and encodes / decodes the stored form', async () => {
    const s = redisSnapshotStore<{ rows: number[]; total: number }, number[]>('k', {
      ttlS: 60,
      compress: true,
      encode: (v) => v.rows,
      decode: (rows) => ({ rows, total: rows.reduce((a, b) => a + b, 0) }),
    });
    await s.save({ rows: [1, 2, 3], total: 6 }, 5);
    expect(store.get('k')?.value).not.toContain('rows');
    await expect(s.load()).resolves.toEqual({ value: { rows: [1, 2, 3], total: 6 }, fetchedAt: 5 });
  });

  it('reads a missing or corrupt entry as nothing stored', async () => {
    const s = redisSnapshotStore('k', { ttlS: 60, compress: true });
    await expect(s.load()).resolves.toBeNull();
    store.set('k', { value: 'not gzip' });
    await expect(s.load()).resolves.toBeNull();
    const plain = redisSnapshotStore('p', { ttlS: 60 });
    store.set('p', { value: '{"value":1}' });
    await expect(plain.load()).resolves.toBeNull();
  });
});
