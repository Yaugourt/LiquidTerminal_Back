/**
 * cacheService.getOrSet: concurrent misses on one key share a single fetchFn
 * in this process. Followers get a copy of what was stored (what reading the
 * cache would give them), never the leader's object. Each fetch also keeps a
 * last copy of the value: served when a later fetch fails (and, for a few
 * seconds after, without asking again), and when an expired live key's
 * refresh does not land within a short wait.
 */
const mockRedis = {
  store: new Map<string, string>(),
  /** Expiry (Date.now() ms) of keys set with a TTL. */
  expiries: new Map<string, number>(),
  locks: new Set<string>(),
  foreignLock: false,
  healthy: true,
  isHealthy: jest.fn(() => mockRedis.healthy),
  get: jest.fn(async (key: string) => {
    const expiry = mockRedis.expiries.get(key);
    if (expiry !== undefined && Date.now() >= expiry) {
      mockRedis.store.delete(key);
      mockRedis.expiries.delete(key);
    }
    return mockRedis.store.get(key) ?? null;
  }),
  set: jest.fn(async (key: string, value: string, ttl?: number) => {
    mockRedis.store.set(key, value);
    if (ttl) mockRedis.expiries.set(key, Date.now() + ttl * 1000);
    else mockRedis.expiries.delete(key);
  }),
  delete: jest.fn(async (key: string) => {
    mockRedis.locks.delete(key);
    mockRedis.store.delete(key);
  }),
  scan: jest.fn(async (pattern: string) => {
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return [...mockRedis.store.keys()].filter((key) => re.test(key));
  }),
  lockFails: false,
  getClient: () => ({
    set: async (key: string) => {
      if (mockRedis.lockFails) throw new Error('lock command failed');
      if (mockRedis.foreignLock || mockRedis.locks.has(key)) return null;
      mockRedis.locks.add(key);
      return 'OK';
    },
    exists: async (key: string) => (mockRedis.foreignLock || mockRedis.locks.has(key) ? 1 : 0),
    expire: async (key: string, seconds: number) => {
      mockRedis.renewals.push([key, seconds]);
      return 1;
    },
  }),
  /** [key, seconds] of every lock renewal. */
  renewals: [] as Array<[string, number]>,
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CacheService, SHARED_LAST_COPY_KEEP_S } from '../../../src/core/cache.service';

const later = <T>(value: T, ms = 30): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('CacheService.getOrSet', () => {
  let cache: CacheService;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.locks.clear();
    mockRedis.foreignLock = false;
    mockRedis.healthy = true;
    mockRedis.lockFails = false;
    mockRedis.set.mockClear();
    cache = new CacheService();
  });

  it('runs fetchFn once for concurrent misses and hands followers a copy', async () => {
    const fetchFn = jest.fn(() => later({ rows: [1, 2, 3], at: new Date(0) }));
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.getOrSet('k', fetchFn, 60)));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The value and its last copy.
    expect(mockRedis.set).toHaveBeenCalledTimes(2);
    const [leader, ...followers] = results;
    expect(leader.at).toBeInstanceOf(Date);
    for (const follower of followers) {
      expect(follower).not.toBe(leader);
      // Exactly what a cache hit returns.
      expect(follower).toEqual(JSON.parse(mockRedis.store.get('k') as string));
    }
  });

  it('still runs fetchFn once when it outlasts the 600 ms lock wait', async () => {
    const fetchFn = jest.fn(() => later('slow', 700));
    const results = await Promise.all(Array.from({ length: 6 }, () => cache.getOrSet('k', fetchFn)));
    expect(results).toEqual(Array(6).fill('slow'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('serves hits from Redis without calling fetchFn', async () => {
    mockRedis.store.set('k', JSON.stringify({ cached: true }));
    const fetchFn = jest.fn(async () => ({ cached: false }));
    await expect(cache.getOrSet('k', fetchFn)).resolves.toEqual({ cached: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('keeps keys independent and recomputes once a miss has settled', async () => {
    const fetchFn = jest.fn(async () => later('v'));
    await Promise.all([cache.getOrSet('a', fetchFn), cache.getOrSet('b', fetchFn)]);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    mockRedis.store.clear();
    await cache.getOrSet('a', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('hands the shared failure to every caller without fetching again', async () => {
    const fetchFn = jest.fn(async () => {
      await later(null);
      throw new Error('upstream down');
    });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => cache.getOrSet('k', fetchFn)));
    for (const result of results) {
      expect(result).toEqual({ status: 'rejected', reason: new Error('upstream down') });
    }
    // One attempt for everyone: the old catch-all ran it again per caller.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('serves the last value, flagged stale, when a refresh fails', async () => {
    await cache.getOrSet('k', async () => ({ v: 1 }), 120);
    mockRedis.store.delete('k'); // expired
    const fetchFn = jest.fn(async () => {
      throw new Error('upstream down');
    });
    const results = await Promise.all(Array.from({ length: 3 }, () => cache.getOrSetWithMeta('k', fetchFn, 120)));
    expect(results).toEqual(Array(3).fill({ data: { v: 1 }, stale: true }));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(cache.getOrSet('k', fetchFn, 120)).resolves.toEqual({ v: 1 });
  });

  it('keeps the last copy about 10 TTLs by default, at most 10 min (or 2 TTLs)', async () => {
    await cache.getOrSet('bar', async () => 1, 5);
    await cache.getOrSet('short', async () => 1, 15);
    await cache.getOrSet('slow', async () => 1, 55, { refreshInBackground: true });
    await cache.getOrSet('minutes', async () => 1, 120);
    await cache.getOrSet('long', async () => 1, 900);
    await cache.getOrSet('day', async () => 1, 86_400);
    // A live key keeps at least its stale-while-revalidate window (a minute).
    expect(mockRedis.set).toHaveBeenCalledWith('bar:last', expect.any(String), 60);
    expect(mockRedis.set).toHaveBeenCalledWith('short:last', expect.stringContaining('"ttl":15,"v":1}'), 150);
    expect(mockRedis.set).toHaveBeenCalledWith('slow:last', expect.any(String), 550);
    expect(mockRedis.set).toHaveBeenCalledWith('minutes:last', expect.any(String), 600);
    expect(mockRedis.set).toHaveBeenCalledWith('long:last', expect.any(String), 1_800);
    expect(mockRedis.set).toHaveBeenCalledWith('day:last', expect.any(String), 2 * 86_400);
  });

  it('keeps an opted-in copy longer, at most a week', async () => {
    await cache.getOrSet('tile', async () => 1, 15, { lastCopyKeepS: SHARED_LAST_COPY_KEEP_S });
    await cache.getOrSet('meta', async () => 1, 120, { lastCopyKeepS: 30 * 86_400 });
    expect(SHARED_LAST_COPY_KEEP_S).toBe(3_600);
    expect(mockRedis.set).toHaveBeenCalledWith('tile:last', expect.any(String), 3_600);
    expect(mockRedis.set).toHaveBeenCalledWith('meta:last', expect.any(String), 7 * 86_400);
  });

  it('skips a large default copy unless the key is live or opted in', async () => {
    const big = 'x'.repeat(300 * 1024);
    await cache.getOrSet('big-slow', async () => big, 120);
    await cache.getOrSet('big-live', async () => big, 15);
    await cache.getOrSet('big-shared', async () => big, 120, { lastCopyKeepS: SHARED_LAST_COPY_KEEP_S });
    expect(mockRedis.store.has('big-slow')).toBe(true);
    expect(mockRedis.store.has('big-slow:last')).toBe(false);
    expect(mockRedis.store.has('big-live:last')).toBe(true);
    expect(mockRedis.store.has('big-shared:last')).toBe(true);
  });

  it('serves an expired live key from its last copy when its single refresh is slow', async () => {
    await cache.getOrSet('live', async () => 'old', 15);
    mockRedis.store.delete('live');
    let release: (value: string) => void = () => undefined;
    const fetchFn = jest.fn(() => new Promise<string>((resolve) => { release = resolve; }));

    // The refresh never lands on its own: readers get the copy after the
    // bounded wait (1.5 s) instead of hanging on the upstream.
    const results = await Promise.all(Array.from({ length: 5 }, () => cache.getOrSetWithMeta('live', fetchFn, 15)));
    expect(results).toEqual(Array(5).fill({ data: 'old', stale: false }));
    expect(fetchFn).toHaveBeenCalledTimes(1);

    release('new');
    await later(null, 10);
    await expect(cache.getOrSet('live', fetchFn, 15)).resolves.toBe('new');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('hands readers of an expired live key the refresh when it lands within the wait', async () => {
    await cache.getOrSet('live', async () => 'old', 15);
    mockRedis.store.delete('live');
    const fetchFn = jest.fn(() => later('new', 50));
    const results = await Promise.all(Array.from({ length: 3 }, () => cache.getOrSetWithMeta('live', fetchFn, 15)));
    expect(results).toEqual(Array(3).fill({ data: 'new', stale: false }));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('never shows one viewer polling at the TTL a value older than about one TTL', async () => {
    // One viewer, alone on a 15 s key, polls every 15 s; the upstream answers
    // in 50 ms. Serving the copy without waiting showed this viewer values
    // 30 s old every other poll (the refresh it started expired one TTL later).
    let clock = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const fetchFn = jest.fn(async () => {
      const fetchedAt = clock;
      await later(null, 50);
      clock += 50;
      return { fetchedAt };
    });
    try {
      for (let poll = 0; poll < 8; poll++) {
        const { data } = await cache.getOrSetWithMeta('fills', fetchFn, 15);
        expect(clock - data.fetchedAt).toBeLessThanOrEqual(15_000 + 50);
        clock += 15_000;
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('flags a copy older than its TTL as stale when the refresh does not land in time', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await cache.getOrSet('live', async () => 'old', 15);
    mockRedis.store.delete('live');
    spy.mockReturnValue(now + 40_000);
    try {
      const result = await cache.getOrSetWithMeta('live', () => new Promise<string>(() => undefined), 15);
      expect(result).toEqual({ data: 'old', stale: true });
    } finally {
      spy.mockRestore();
    }
  }, 15_000);

  it('does not retry a failing live key on every read', async () => {
    await cache.getOrSet('live', async () => 'old', 15);
    mockRedis.store.delete('live');
    const fetchFn = jest.fn(async () => {
      throw new Error('upstream down');
    });
    for (let i = 0; i < 5; i++) {
      await expect(cache.getOrSet('live', fetchFn, 15)).resolves.toBe('old');
    }
    // One attempt, then the failure marker holds the others off for the backoff.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith('live:fail', '1', 10);
  });

  it('does not refetch a failing slow key on every read while a copy exists', async () => {
    await cache.getOrSet('slow', async () => 'old', 120);
    mockRedis.store.delete('slow');
    const fetchFn = jest.fn(async () => {
      throw new Error('upstream down');
    });
    for (let i = 0; i < 4; i++) {
      await expect(cache.getOrSetWithMeta('slow', fetchFn, 120)).resolves.toEqual({ data: 'old', stale: true });
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Once the backoff is over, the key is fetched again.
    mockRedis.store.delete('slow:fail');
    await expect(cache.getOrSet('slow', async () => 'new', 120)).resolves.toBe('new');
  });

  describe('a caller refused for its own budget', () => {
    class Refused extends Error {
      readonly callerRefusal = true;
    }

    it('leaves no failure marker, so the next visitor fetches the key', async () => {
      const refused = jest.fn(async () => {
        throw new Refused('over budget');
      });
      await expect(cache.getOrSet('budget', refused, 15)).rejects.toThrow('over budget');
      expect(mockRedis.store.has('budget:fail')).toBe(false);

      // Someone else asks for the same key right after: it is fetched, not held off.
      await expect(cache.getOrSet('budget', async () => 'fresh', 15)).resolves.toBe('fresh');
    });

    it('does not hold other visitors off a key that has a last copy', async () => {
      await cache.getOrSet('copy', async () => 'old', 120);
      mockRedis.store.delete('copy'); // expired
      const refused = jest.fn(async () => {
        throw new Refused('over budget');
      });
      // The refused caller still gets the last copy...
      await expect(cache.getOrSetWithMeta('copy', refused, 120)).resolves.toEqual({ data: 'old', stale: true });
      expect(mockRedis.store.has('copy:fail')).toBe(false);
      // ...and the next visitor's fetch runs instead of being served it for the backoff.
      const ok = jest.fn(async () => 'new');
      await expect(cache.getOrSet('copy', ok, 120)).resolves.toBe('new');
      expect(ok).toHaveBeenCalledTimes(1);
    });

    it('still marks a plain upstream failure', async () => {
      await expect(
        cache.getOrSet('down', async () => {
          throw new Error('upstream down');
        }, 15)
      ).rejects.toThrow('upstream down');
      expect(mockRedis.store.has('down:fail')).toBe(true);
    });
  });

  it('still fetches a key without a copy after a failure', async () => {
    const failing = jest.fn(async () => {
      throw new Error('upstream down');
    });
    await expect(cache.getOrSet('cold', failing, 120)).rejects.toThrow('upstream down');
    await expect(cache.getOrSet('cold', async () => 'ok', 120)).resolves.toBe('ok');
  });

  it('waits for the fetch on a live key that opts out of stale-while-revalidate', async () => {
    await cache.getOrSet('page', async () => 'old', 10);
    mockRedis.store.delete('page');
    const fetchFn = jest.fn(() => later('new', 50));
    await expect(cache.getOrSet('page', fetchFn, 10, { staleWhileRevalidate: false })).resolves.toBe('new');
    // Still served on failure.
    mockRedis.store.delete('page');
    await expect(
      cache.getOrSetWithMeta('page', async () => { throw new Error('down'); }, 10, { staleWhileRevalidate: false })
    ).resolves.toEqual({ data: 'new', stale: true });
  });

  it('drops an older copy when a newer value is too big to copy', async () => {
    await cache.getOrSet('grows', async () => 'small', 120);
    expect(mockRedis.store.has('grows:last')).toBe(true);
    mockRedis.store.delete('grows');
    await cache.getOrSet('grows', async () => 'x'.repeat(300 * 1024), 120);
    expect(mockRedis.store.has('grows:last')).toBe(false);
  });

  it('waits for the fetch when the live copy is old or the key is not live', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await cache.getOrSet('live', async () => 'old', 15);
    await cache.getOrSet('slow', async () => 'old', 120);
    mockRedis.store.delete('live');
    mockRedis.store.delete('slow');

    // A live copy is served while it is less than 4 TTLs (at least a minute) old.
    spy.mockReturnValue(now + 61_000);
    await expect(cache.getOrSet('live', async () => 'new', 15)).resolves.toBe('new');
    await expect(cache.getOrSet('slow', async () => 'new', 120)).resolves.toBe('new');
    spy.mockRestore();
  });

  it('refreshes a slower key in the background when asked to', async () => {
    await cache.getOrSet('slow', async () => 'old', 55);
    mockRedis.store.delete('slow');
    const fetchFn = jest.fn(() => later('new'));
    await expect(cache.getOrSet('slow', fetchFn, 55, { refreshInBackground: true })).resolves.toBe('old');
    await later(null, 50);
    await expect(cache.getOrSet('slow', fetchFn, 55, { refreshInBackground: true })).resolves.toBe('new');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('still fetches directly when the cache itself fails', async () => {
    mockRedis.lockFails = true;
    const fetchFn = jest.fn(async () => 'direct');
    await expect(cache.getOrSet('k', fetchFn)).resolves.toBe('direct');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps no last copy when asked not to', async () => {
    await cache.getOrSet('k', async () => 1, 15, { lastCopy: false });
    expect(mockRedis.store.has('k:last')).toBe(false);
  });

  it('drops the last copy with the key on invalidation', async () => {
    await cache.getOrSet('list:1', async () => 1, 120);
    await cache.getOrSet('list:2', async () => 2, 120);
    await cache.getOrSet('other', async () => 3, 120);
    await cache.invalidate('list:1');
    expect(mockRedis.store.has('list:1')).toBe(false);
    expect(mockRedis.store.has('list:1:last')).toBe(false);
    await cache.invalidateByPattern('list:*');
    expect([...mockRedis.store.keys()].sort()).toEqual(['other', 'other:last']);
  });

  it('shares the wait when another instance holds the Redis lock', async () => {
    mockRedis.foreignLock = true;
    // The other instance gives up without caching: waiters stop polling once
    // its lock is gone instead of waiting out the 15 s.
    setTimeout(() => { mockRedis.foreignLock = false; }, 600);
    const fetchFn = jest.fn(async () => 'mine');
    const results = await Promise.all(Array.from({ length: 5 }, () => cache.getOrSet('k', fetchFn)));
    expect(results).toEqual(['mine', 'mine', 'mine', 'mine', 'mine']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('skips Redis entirely while its circuit is open', async () => {
    mockRedis.healthy = false;
    mockRedis.store.set('k', JSON.stringify('cached'));
    mockRedis.get.mockClear();
    const fetchFn = jest.fn(async () => 'fresh');
    await expect(cache.getOrSet('k', fetchFn)).resolves.toBe('fresh');
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('shares one direct fetch per key while Redis is down', async () => {
    mockRedis.healthy = false;
    const fetchFn = jest.fn(() => later({ rows: [1] }));
    const results = await Promise.all(Array.from({ length: 5 }, () => cache.getOrSet('k', fetchFn)));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results).toEqual(Array(5).fill({ rows: [1] }));
    // Followers get copies, not the leader's object.
    expect(new Set(results).size).toBe(5);
  });

  it('shares one direct fetch per key when the cache itself fails', async () => {
    mockRedis.lockFails = true;
    const fetchFn = jest.fn(() => later('direct'));
    const results = await Promise.all(Array.from({ length: 4 }, () => cache.getOrSet('k', fetchFn)));
    expect(results).toEqual(Array(4).fill('direct'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stores a constant TTL as given', async () => {
    await cache.getOrSet('k', async () => [1], 55);
    expect(mockRedis.set).toHaveBeenCalledWith('k', '[1]', 55);
  });

  it('derives the TTL from the fetched value when given a function', async () => {
    const ttl = jest.fn((rows: number[]) => (rows.length === 0 ? 3600 : 60));
    await cache.getOrSet('empty', async () => [] as number[], ttl);
    await cache.getOrSet('busy', async () => [1, 2], ttl);
    expect(ttl).toHaveBeenNthCalledWith(1, []);
    expect(ttl).toHaveBeenNthCalledWith(2, [1, 2]);
    expect(mockRedis.set).toHaveBeenCalledWith('empty', '[]', 3600);
    expect(mockRedis.set).toHaveBeenCalledWith('busy', '[1,2]', 60);
  });

  it('never stores a key without expiry, whatever the TTL function returns', async () => {
    const cases: Array<[string, number, number]> = [
      ['zero', 0, 1],
      ['negative', -5, 1],
      ['fraction', 2.2, 3],
      ['nan', Number.NaN, 300],
    ];
    for (const [key, returned, stored] of cases) {
      await cache.getOrSet(key, async () => 'v', () => returned);
      expect(mockRedis.set).toHaveBeenCalledWith(key, '"v"', stored);
    }
  });

  it('keeps the fetched value and the default TTL when the TTL function throws', async () => {
    const fetchFn = jest.fn(async () => 'paid for');
    const result = await cache.getOrSet('k', fetchFn, () => {
      throw new Error('bad ttl');
    });
    expect(result).toBe('paid for');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith('k', '"paid for"', 300);
  });
});

describe('CacheService.getOrRefresh', () => {
  let cache: CacheService;
  const seed = (key: string, value: unknown, ageMs: number): void => {
    mockRedis.store.set(`${key}:swr`, JSON.stringify({ at: Date.now() - ageMs, value }));
  };
  /** A fetchFn that waits to be released. */
  const gate = <T>(value: T) => {
    let release!: () => void;
    let fail!: (error: Error) => void;
    const fn = jest.fn(
      () =>
        new Promise<T>((resolve, reject) => {
          release = () => resolve(value);
          fail = reject;
        })
    );
    return { fn, release: () => release(), fail: (e: Error) => fail(e) };
  };
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    cache = new CacheService();
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.locks.clear();
    mockRedis.renewals.length = 0;
    mockRedis.foreignLock = false;
    mockRedis.lockFails = false;
    mockRedis.healthy = true;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('serves the last value at once and refreshes it behind, once, for everyone asking meanwhile', async () => {
    seed('agg', 'old', 120_000);
    const g = gate('new');

    const answers = await Promise.all(Array.from({ length: 6 }, () => cache.getOrRefresh('agg', g.fn, 60, 3600)));
    expect(answers).toEqual(Array(6).fill('old'));
    await tick();
    expect(g.fn).toHaveBeenCalledTimes(1);
    expect(mockRedis.locks.has('lock:agg:swr')).toBe(true);

    g.release();
    await tick();
    await tick();
    expect(await cache.getOrRefresh('agg', g.fn, 60, 3600)).toBe('new');
    expect(g.fn).toHaveBeenCalledTimes(1);
    expect(mockRedis.locks.has('lock:agg:swr')).toBe(false);
  });

  it('does not start a second refresh when the first outlives its lock', async () => {
    seed('slow', 'old', 120_000);
    const g = gate('new');
    await cache.getOrRefresh('slow', g.fn, 60, 3600);
    await tick();
    // The lock is gone (expired, or released by someone else) while the refresh still runs.
    mockRedis.locks.delete('lock:slow:swr');

    for (let i = 0; i < 5; i++) expect(await cache.getOrRefresh('slow', g.fn, 60, 3600)).toBe('old');
    await tick();
    expect(g.fn).toHaveBeenCalledTimes(1);

    g.release();
    await tick();
    await tick();
    expect(await cache.getOrRefresh('slow', g.fn, 60, 3600)).toBe('new');
  });

  it('renews its lock for as long as the refresh runs', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    seed('long', 'old', 120_000);
    const g = gate('new');
    await cache.getOrRefresh('long', g.fn, 60, 3600);
    await tick();

    jest.advanceTimersByTime(45_000 * 3 + 1);
    expect(mockRedis.renewals).toEqual([
      ['lock:long:swr', 120],
      ['lock:long:swr', 120],
      ['lock:long:swr', 120],
    ]);

    g.release();
    await tick();
    await tick();
    jest.advanceTimersByTime(200_000);
    expect(mockRedis.renewals).toHaveLength(3);
  });

  it('keeps serving the last value when the refresh fails, and waits 30 s before another', async () => {
    let now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    seed('flaky', 'old', 120_000);
    const failing = jest.fn(async () => {
      throw new Error('canceling statement due to statement timeout');
    });

    expect(await cache.getOrRefresh('flaky', failing, 60, 3600)).toBe('old');
    await tick();
    await tick();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(mockRedis.locks.has('lock:flaky:swr')).toBe(false);

    now += 29_000;
    expect(await cache.getOrRefresh('flaky', failing, 60, 3600)).toBe('old');
    await tick();
    expect(failing).toHaveBeenCalledTimes(1);

    now += 2_000;
    const working = jest.fn(async () => 'new');
    expect(await cache.getOrRefresh('flaky', working, 60, 3600)).toBe('old');
    await tick();
    await tick();
    expect(working).toHaveBeenCalledTimes(1);
    expect(await cache.getOrRefresh('flaky', working, 60, 3600)).toBe('new');
  });

  it('leaves the refresh to another instance that holds the lock, and can take it later', async () => {
    seed('shared', 'old', 120_000);
    const fetchFn = jest.fn(async () => 'new');
    mockRedis.foreignLock = true;
    expect(await cache.getOrRefresh('shared', fetchFn, 60, 3600)).toBe('old');
    await tick();
    expect(fetchFn).not.toHaveBeenCalled();

    mockRedis.foreignLock = false;
    expect(await cache.getOrRefresh('shared', fetchFn, 60, 3600)).toBe('old');
    await tick();
    await tick();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('still serves the last value when the lock itself cannot be taken', async () => {
    seed('nolock', 'old', 120_000);
    const fetchFn = jest.fn(async () => 'new');
    mockRedis.lockFails = true;
    expect(await cache.getOrRefresh('nolock', fetchFn, 60, 3600)).toBe('old');
    await tick();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not refresh a value that is still fresh', async () => {
    seed('fresh', 'value', 10_000);
    const fetchFn = jest.fn(async () => 'new');
    expect(await cache.getOrRefresh('fresh', fetchFn, 60, 3600)).toBe('value');
    await tick();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('computes a cold key once for concurrent callers', async () => {
    const fetchFn = jest.fn(() => later('first', 20));
    const answers = await Promise.all(Array.from({ length: 5 }, () => cache.getOrRefresh('cold', fetchFn, 60, 3600)));
    expect(answers).toEqual(Array(5).fill('first'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('with Redis unusable, computes once for the callers asking together', async () => {
    mockRedis.healthy = false;
    const fetchFn = jest.fn(() => later('direct', 20));
    const answers = await Promise.all(Array.from({ length: 5 }, () => cache.getOrRefresh('down', fetchFn, 60, 3600)));
    expect(answers).toEqual(Array(5).fill('direct'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Kept in this process while it is fresh: a later caller does not compute again.
    await expect(cache.getOrRefresh('down', fetchFn, 60, 3600)).resolves.toBe('direct');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

/**
 * With Redis down every read went to its source: each poll of each visitor was a billed call or
 * a query of seconds. What is fetched during the outage is now kept in this process for the
 * key's TTL.
 */
describe('CacheService while Redis cannot be used', () => {
  let cache: CacheService;
  let now: number;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.locks.clear();
    mockRedis.foreignLock = false;
    mockRedis.lockFails = false;
    mockRedis.healthy = false;
    mockRedis.get.mockClear();
    mockRedis.set.mockClear();
    now = Date.parse('2026-11-12T10:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    cache = new CacheService();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    mockRedis.healthy = true;
  });

  it('keeps a value for its TTL: the source is asked as often as when the cache works', async () => {
    let calls = 0;
    const fetchFn = jest.fn(async () => ({ n: ++calls }));
    for (let second = 0; second < 15; second++) {
      await cache.getOrSet('list', fetchFn, 5);
      now += 1000;
    }
    // 15 seconds of polls on a 5-second key: 3 fetches, not 15.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('hands out copies: what a caller does to its value stays its own', async () => {
    const first = await cache.getOrSet('obj', async () => ({ rows: [1, 2] }), 60);
    first.rows.push(99);
    await expect(cache.getOrSet('obj', async () => ({ rows: [] as number[] }), 60)).resolves.toEqual({ rows: [1, 2] });
  });

  it('keeps a long-lived key five minutes at most, and a key with a computed TTL for that TTL', async () => {
    const hourly = jest.fn(async () => 'h');
    await cache.getOrSet('hourly', hourly, 3600);
    now += 299_000;
    await cache.getOrSet('hourly', hourly, 3600);
    expect(hourly).toHaveBeenCalledTimes(1);
    now += 2_000;
    await cache.getOrSet('hourly', hourly, 3600);
    expect(hourly).toHaveBeenCalledTimes(2);

    const computed = jest.fn(async () => ({ live: true }));
    await cache.getOrSet('computed', computed, (value) => (value.live ? 2 : 600));
    now += 1_500;
    await cache.getOrSet('computed', computed, () => 2);
    expect(computed).toHaveBeenCalledTimes(1);
    now += 1_000;
    await cache.getOrSet('computed', computed, () => 2);
    expect(computed).toHaveBeenCalledTimes(2);
  });

  it('does not keep a value over 1 MB, nor a value that cannot be written as JSON', async () => {
    const big = jest.fn(async () => 'x'.repeat(1024 * 1024 + 1));
    await cache.getOrSet('big', big, 60);
    await cache.getOrSet('big', big, 60);
    expect(big).toHaveBeenCalledTimes(2);

    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const circular = jest.fn(async () => loop);
    await cache.getOrSet('circular', circular, 60);
    await cache.getOrSet('circular', circular, 60);
    expect(circular).toHaveBeenCalledTimes(2);
  });

  it('holds 32 MB of values in all: the least recently written leave first', async () => {
    const value = 'v'.repeat(1_000_000);
    const fetchFn = jest.fn(async () => value);
    for (let i = 0; i < 40; i++) await cache.getOrSet(`k${i}`, fetchFn, 60);
    expect(fetchFn).toHaveBeenCalledTimes(40);
    // The newest are still there, the oldest are gone.
    await cache.getOrSet('k39', fetchFn, 60);
    await cache.getOrSet('k20', fetchFn, 60);
    expect(fetchFn).toHaveBeenCalledTimes(40);
    await cache.getOrSet('k0', fetchFn, 60);
    expect(fetchFn).toHaveBeenCalledTimes(41);
    const held = (cache as unknown as { memoryChars: number }).memoryChars;
    expect(held).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it('keeps what an aggregate computed too (getOrRefresh), for its fresh time', async () => {
    const compute = jest.fn(async () => 'agg');
    await cache.getOrRefresh('agg', compute, 60, 3600);
    now += 59_000;
    await cache.getOrRefresh('agg', compute, 60, 3600);
    expect(compute).toHaveBeenCalledTimes(1);
    now += 2_000;
    await cache.getOrRefresh('agg', compute, 60, 3600);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('forgets a key that is invalidated, by name or by pattern', async () => {
    const fetchFn = jest.fn(async () => 1);
    await cache.getOrSet('wallet:0xabc:fills', fetchFn, 60);
    await cache.getOrSet('wallet:0xabc:funding', fetchFn, 60);
    await cache.getOrSet('other', fetchFn, 60);
    await cache.invalidate('other');
    await cache.invalidateByPattern('wallet:0xabc:*');
    await cache.getOrSet('wallet:0xabc:fills', fetchFn, 60);
    await cache.getOrSet('wallet:0xabc:funding', fetchFn, 60);
    await cache.getOrSet('other', fetchFn, 60);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('reads Redis again as soon as it is back', async () => {
    await cache.getOrSet('k', async () => 'during the outage', 60);
    mockRedis.healthy = true;
    mockRedis.store.set('k', JSON.stringify('from Redis'));
    await expect(cache.getOrSet('k', async () => 'fetched', 60)).resolves.toBe('from Redis');
  });

  it('keeps a value too when Redis answers but the cache itself fails', async () => {
    mockRedis.healthy = true;
    const broken = new Error('READONLY You can\'t write against a read only replica');
    mockRedis.get.mockRejectedValueOnce(broken).mockRejectedValueOnce(broken);
    const fetchFn = jest.fn(async () => 'source');
    await expect(cache.getOrSet('broken', fetchFn, 30)).resolves.toBe('source');
    await expect(cache.getOrSet('broken', fetchFn, 30)).resolves.toBe('source');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
