/**
 * IndexerTwapsService.getTwapSource: the front's TWAP source in one shared
 * aggregate. Pages of 500 (≤ 12, stopping at a short page) read through
 * listTwaps, the first page on every refresh, the deeper pages at most once a
 * minute per query from their own cache key, merged by twapId (fresher wins).
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * A cacheService that honours the contract the service relies on: a fresh
 * entry is served, an expired one is fetched, and a failed fetch serves the
 * last copy (lastCopy not false) or throws.
 */
interface Entry {
  value: unknown;
  at: number;
  ttl: number;
}
const entries = new Map<string, Entry>();
const getOrSet = jest.fn(
  async (key: string, fetchFn: () => Promise<unknown>, ttl: number, options: { lastCopy?: boolean } = {}) => {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < hit.ttl * 1000) return hit.value;
    try {
      const value = await fetchFn();
      entries.set(key, { value, at: Date.now(), ttl });
      return value;
    } catch (error) {
      if (hit && options.lastCopy !== false) return hit.value;
      throw error;
    }
  }
);
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: { getOrSet: (...args: Parameters<typeof getOrSet>) => getOrSet(...args) },
  SHARED_LAST_COPY_KEEP_S: 3_600,
}));

jest.mock('../../../src/clients/hypedexer/rest/twaps/twaps.client', () => ({
  HypeDexerTwapsClient: { getInstance: () => ({}) },
}));

import type { IndexerTwap, IndexerTwapsService } from '../../../src/services/indexer/indexer-twaps.service';

type Query = { status?: string; hours?: number; limit?: number; offset?: number };
type QueryName = 'recent' | 'running';

const T0 = 1_800_000_000_000;
let now = T0;

const row = (twapId: number, status = 'activated'): IndexerTwap => ({
  twapId,
  status,
  coin: 'BTC',
  user: '0xabc',
  side: 'B',
  sz: 1,
  executedSz: 0,
  executedNtl: 0,
  minutes: 30,
  reduceOnly: false,
  randomize: false,
  startTime: '2026-10-13T10:00:00',
  updatedAt: '2026-10-13T10:00:00',
});
const ids = (rows: IndexerTwap[]): number[] => rows.map((r) => r.twapId);
const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);
const rowsOf = (twapIds: number[], status = 'activated'): IndexerTwap[] => twapIds.map((id) => row(id, status));

describe('IndexerTwapsService.getTwapSource', () => {
  /** What the upstream holds per query, newest first; pages are slices of it. */
  let dataset: Record<QueryName, IndexerTwap[]>;
  let service: IndexerTwapsService;
  let listTwaps: jest.SpyInstance;
  let fail: (query: Query) => boolean;

  const nameOf = (q: Query): QueryName => (q.status === 'activated' ? 'running' : 'recent');
  const callsOf = (name: QueryName): Query[] =>
    listTwaps.mock.calls.map((c) => c[0] as Query).filter((q) => nameOf(q) === name);
  const offsetsOf = (name: QueryName): number[] => callsOf(name).map((q) => q.offset ?? -1);
  /** Advances the clock past the aggregate TTL (15 s) only. */
  const tick = (ms: number): void => {
    now += ms;
  };

  beforeEach(() => {
    jest.resetModules();
    entries.clear();
    getOrSet.mockClear();
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    dataset = { recent: [], running: [] };
    fail = () => false;
    const { IndexerTwapsService: Service } = require('../../../src/services/indexer/indexer-twaps.service');
    service = Service.getInstance();
    listTwaps = jest.spyOn(service, 'listTwaps').mockImplementation(async (params: Query) => {
      if (fail(params)) throw new Error('indexer down');
      const all = dataset[nameOf(params)];
      const offset = params.offset ?? 0;
      return all.slice(offset, offset + (params.limit ?? 0));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads both queries with the front\'s params and wraps them with updatedAt', async () => {
    dataset.recent = rowsOf([3, 2, 1], 'finished');
    dataset.running = rowsOf([9]);

    const source = await service.getTwapSource();

    expect(ids(source.recent)).toEqual([3, 2, 1]);
    expect(ids(source.running)).toEqual([9]);
    expect(source.updatedAt).toBe(T0);
    expect(source.deepAt).toEqual({ recent: null, running: null });
    expect(callsOf('recent')).toEqual([{ hours: 24, limit: 500, offset: 0 }]);
    expect(callsOf('running')).toEqual([{ status: 'activated', hours: 170, limit: 500, offset: 0 }]);
  });

  it('is one fixed key, 15 s, with its last copy and background refresh', async () => {
    await service.getTwapSource();

    expect(getOrSet).toHaveBeenCalledWith(
      'hypedexer:twaps:source',
      expect.any(Function),
      15,
      { lastCopy: true, refreshInBackground: true }
    );
    // A second reader inside the TTL costs nothing upstream.
    const calls = listTwaps.mock.calls.length;
    tick(14_000);
    await service.getTwapSource();
    expect(listTwaps.mock.calls.length).toBe(calls);
  });

  it('stops at the first page of fewer than 500 rows and never walks deeper', async () => {
    dataset.recent = rowsOf(range(1, 499));

    await service.getTwapSource();

    expect(offsetsOf('recent')).toEqual([0]);
    expect(getOrSet.mock.calls.map((c) => c[0])).not.toContain('hypedexer:twaps:source-deep:recent');
  });

  it('walks the deep pages after a full first page, until a short page, and keeps their rows out of the aggregate', async () => {
    dataset.recent = rowsOf(range(1, 1_300)); // 500 + 500 + 300

    const source = await service.getTwapSource();

    expect(offsetsOf('recent')).toEqual([0, 500, 1000]);
    expect(ids(source.recent)).toEqual(range(1, 500));
    expect(source.deepAt).toEqual({ recent: T0, running: null });
    expect(getOrSet).toHaveBeenCalledWith(
      'hypedexer:twaps:source-deep:recent',
      expect.any(Function),
      60,
      { lastCopy: true, refreshInBackground: true }
    );
  });

  it('walks at most 12 pages of a query (the first plus 11 deep ones)', async () => {
    dataset.recent = rowsOf(range(1, 20 * 500));

    const deep = await service.getTwapSource().then(() => service.getTwapSourceDeep());

    expect(offsetsOf('recent')).toEqual(range(0, 12).map((i) => i * 500));
    expect(deep.recent?.rows).toHaveLength(11 * 500);
  });

  it('stops the walk after a full last page without asking for an empty one more', async () => {
    dataset.recent = rowsOf(range(1, 1_000)); // exactly 2 full pages

    await service.getTwapSource();

    // Page 1 is full, so page 2 is read (empty) and ends the walk.
    expect(offsetsOf('recent')).toEqual([0, 500, 1000]);
  });

  it('re-reads the first page on every refresh but walks the deep pages at most once a minute', async () => {
    dataset.recent = rowsOf(range(1, 1_100));

    await service.getTwapSource(); // t=0: walk
    for (const step of [15_000, 15_000, 15_000]) {
      tick(step);
      await service.getTwapSource(); // t=15, 30, 45
    }
    expect(offsetsOf('recent')).toEqual([0, 500, 1000, 0, 0, 0]);

    tick(15_000); // t=60: the deep key expired
    await service.getTwapSource();
    expect(offsetsOf('recent')).toEqual([0, 500, 1000, 0, 0, 0, 0, 500, 1000]);
  });

  it('keeps one deep copy per query: a short running query never reads deep pages', async () => {
    dataset.recent = rowsOf(range(1, 600));
    dataset.running = rowsOf([9]);

    await service.getTwapSource();
    tick(15_000);
    await service.getTwapSource();

    expect(offsetsOf('running')).toEqual([0, 0]);
  });

  it('lists the current first page over an earlier sighting of the same TWAP: fresher wins', async () => {
    dataset.recent = rowsOf(range(1, 600));
    await service.getTwapSource(); // TWAP 5 'activated' on the first page

    tick(15_000);
    dataset.recent[4] = row(5, 'finished');
    const source = await service.getTwapSource();

    expect(source.recent.filter((r) => r.twapId === 5).map((r) => r.status)).toEqual(['finished']);
    expect(new Set(ids(source.recent)).size).toBe(source.recent.length);
  });

  it('keeps a row pushed past the first page, with its last-seen state, until the next deep walk lands', async () => {
    const base = rowsOf(range(1, 1_100));
    dataset.recent = base;
    await service.getTwapSource(); // t=0: ids 1..500 on the first page, 501..1100 deep

    // t=15: 600 newer TWAPs pushed id 1 past the first page; it stays listed with the state seen.
    tick(15_000);
    dataset.recent = [...rowsOf(range(5_000, 600)), ...base.filter((r) => r.twapId !== 1)];
    let source = await service.getTwapSource();
    expect(ids(source.recent)).toContain(1);
    expect(source.deepAt.recent).toBe(T0);

    // t=60: a new walk (taken once id 1 had left the upstream's pages) lands: what was seen before it is dropped.
    tick(45_000);
    source = await service.getTwapSource();
    expect(source.deepAt.recent).toBe(T0 + 60_000);
    expect(offsetsOf('recent').filter((o) => o > 0)).toEqual([500, 1000, 500, 1000, 1500]);
    expect(ids(source.recent)).not.toContain(1);
    expect(ids(source.recent)).toEqual(range(5_000, 500));
  });

  it('serves the deep rows apart, with the start of their walk, for a query with a full first page only', async () => {
    dataset.recent = rowsOf(range(1, 1_100));
    dataset.running = rowsOf([9]);

    const deep = await service.getTwapSourceDeep();

    expect(deep.running).toBeNull();
    expect(deep.recent?.at).toBe(T0);
    expect(ids(deep.recent?.rows ?? [])).toEqual(range(501, 600));
    // One walk for the aggregate and the deep route together, and no deep read for the short query.
    expect(offsetsOf('recent')).toEqual([0, 500, 1000]);
    expect(offsetsOf('running')).toEqual([0]);
  });

  it('reads the deep route from the cached aggregate and deep copy: no upstream call inside their TTLs', async () => {
    dataset.recent = rowsOf(range(1, 800));
    await service.getTwapSource();
    const before = listTwaps.mock.calls.length;

    tick(5_000);
    const deep = await service.getTwapSourceDeep();

    expect(listTwaps.mock.calls.length).toBe(before);
    expect(deep.recent?.at).toBe(T0);
  });

  it('keeps the previous deep rows when a deep walk fails', async () => {
    dataset.recent = rowsOf(range(1, 800));
    await service.getTwapSource();

    tick(60_000);
    fail = (q) => (q.offset ?? 0) > 0;
    const source = await service.getTwapSource();
    const deep = await service.getTwapSourceDeep();

    // The walk was retried and failed on its first deep page (the real cache backs off between attempts).
    expect(new Set(offsetsOf('recent').filter((o) => o > 0))).toEqual(new Set([500]));
    expect(source.deepAt.recent).toBe(T0);
    expect(deep.recent?.at).toBe(T0);
    expect(deep.recent?.rows).toHaveLength(300);
  });

  it('throws when a deep walk fails and there is no previous copy', async () => {
    dataset.recent = rowsOf(range(1, 800));
    fail = (q) => (q.offset ?? 0) > 0;

    await expect(service.getTwapSource()).rejects.toThrow('indexer down');
    await expect(service.getTwapSourceDeep()).rejects.toThrow('indexer down');
  });

  it('throws when a first page fails, and serves the last aggregate on the next try', async () => {
    dataset.recent = rowsOf([1, 2]);
    dataset.running = rowsOf([9]);
    const good = await service.getTwapSource();

    tick(20_000);
    fail = (q) => nameOf(q) === 'running';
    // The cache contract: the failed refresh falls back to the last copy.
    const served = await service.getTwapSource();
    expect(served).toEqual(good);

    // And with no copy at all the failure surfaces (the route answers 503).
    entries.clear();
    await expect(service.getTwapSource()).rejects.toThrow('indexer down');
  });

  it('rejects a payload that is not a list', async () => {
    listTwaps.mockResolvedValue({ error: 'x' });

    await expect(service.getTwapSource()).rejects.toThrow('Unexpected indexer TWAPs payload');
  });
});
