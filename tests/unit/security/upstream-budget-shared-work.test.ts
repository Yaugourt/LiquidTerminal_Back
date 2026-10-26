/**
 * What the per-client budget does to shared work. It is decided once, when the
 * request enters, and a request that starts within budget is served whole:
 * the shared computations it triggers (a fan-out recompute that tolerates
 * failed reads and keeps its result for everyone) complete with every read
 * made, however far the calls take its counter. A request that entered over
 * budget never STARTS work: it gets a hit, joins what already runs, is served
 * the key's last copy, or its refusal, and leaves no ":fail" marker and no
 * partial result behind.
 */
process.env.HYPEDEXER_MISS_BUDGET_MINUTE = '5';
process.env.HYPEDEXER_MISS_BUDGET_HOUR = '1000';

import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';

// One fake Redis for the cache (strings, NX locks) and the budget counters (INCR, MGET).
const mockRedis = {
  store: new Map<string, string>(),
  expiries: new Map<string, number>(),
  locks: new Set<string>(),
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
  scan: jest.fn(async () => []),
  getClient: () => ({
    set: async (key: string) => {
      if (mockRedis.locks.has(key)) return null;
      mockRedis.locks.add(key);
      return 'OK';
    },
    exists: async (key: string) => (mockRedis.locks.has(key) ? 1 : 0),
    mget: async (...keys: string[]) => keys.map((key) => mockRedis.store.get(key) ?? null),
    pipeline: () => {
      const ops: (() => [Error | null, unknown])[] = [];
      const pipeline = {
        incr: (key: string) => {
          ops.push(() => {
            const next = Number(mockRedis.store.get(key) ?? 0) + 1;
            mockRedis.store.set(key, String(next));
            return [null, next];
          });
          return pipeline;
        },
        expire: () => {
          ops.push(() => [null, 1]);
          return pipeline;
        },
        exec: async () => ops.map((op) => op()),
      };
      return pipeline;
    },
  }),
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CacheService } from '../../../src/core/cache.service';
import { withRedisCache } from '../../../src/clients/hypedexer/rest/shared/hypedexer-cache.helper';
import { HypeDexerBaseClient } from '../../../src/clients/hypedexer/rest/shared/hypedexer-base.client';
import { passthroughRateLimiter, peekUpstreamBudget, countUpstreamCall } from '../../../src/middleware/apiRateLimiter';
import { currentUpstreamCaller, runWithUpstreamCaller } from '../../../src/utils/request-context';
import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';

class TestClient extends HypeDexerBaseClient {
  constructor() {
    super('http://hypedexer.test');
  }
  read(path: string): Promise<unknown> {
    return this.getUnwrapped<unknown>(path);
  }
}

function exchange(ip: string): { req: Request; res: Response & EventEmitter } {
  const res = Object.assign(new EventEmitter(), {
    setHeader: () => res,
    status: () => res,
    json: () => res,
  }) as unknown as Response & EventEmitter;
  return { req: { ip, path: '/x', query: {} } as Request, res };
}

/** Runs `inside` as the request of `ip`, with its budget peeked from the (fake) Redis on entry, as the limiter does. */
function request<T>(ip: string, inside: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { req, res } = exchange(ip);
    void runWithUpstreamCaller(req, res, (() => {
      inside().then(resolve, reject);
    }) as NextFunction, peekUpstreamBudget);
  });
}

/** Puts `ip` at its minute limit (5), as if it had just made 5 billed calls. */
function exhaust(ip: string): void {
  mockRedis.store.set(`ratelimit:hdmiss:${ip}:minute:${Math.floor(Date.now() / 1000 / 60)}`, '5');
}

const counted = (ip: string): number =>
  [...mockRedis.store].filter(([key]) => key.startsWith(`ratelimit:hdmiss:${ip}:minute:`)).reduce((n, [, v]) => n + Number(v), 0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const later = <T>(value: T, ms = 30): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('budget and shared work', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: TestClient;
  let cache: CacheService;

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const failMarkers = (): string[] => [...mockRedis.store.keys()].filter((key) => key.endsWith(':fail'));

  /** Like computeResolutions: many reads, each one's failure tolerated (undefined), the result kept for everyone. */
  const fanOut = (reads: number) => async (): Promise<Array<unknown | undefined>> =>
    Promise.all(Array.from({ length: reads }, (_, i) => client.read(`/read/${i}`).catch(() => undefined)));

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.locks.clear();
    mockRedis.healthy = true;
    mockRedis.set.mockClear();
    fetchMock = jest.fn(async () => json({ data: ['row'] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new TestClient();
    cache = new CacheService();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('a caller within budget on entry', () => {
    it('completes a fan-out recompute with every read made, however far it takes the counter', async () => {
      // 5 a minute, 2 already spent: within budget on entry. The recompute makes 12 reads.
      mockRedis.store.set(`ratelimit:hdmiss:4.4.4.4:minute:${Math.floor(Date.now() / 1000 / 60)}`, '2');
      const value = await request('4.4.4.4', () => cache.getOrSet('resolutions', fanOut(12), 3600));
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(12);
      // Not one read was refused: nothing missing from what everyone is served.
      expect(value).toHaveLength(12);
      expect(value.every((read) => read !== undefined)).toBe(true);
      expect(counted('4.4.4.4')).toBe(14);

      // Every other visitor is served that complete result.
      await expect(request('5.5.5.5', () => cache.getOrSet('resolutions', fanOut(12), 3600))).resolves.toEqual(value);
      expect(fetchMock).toHaveBeenCalledTimes(12);
      expect(counted('5.5.5.5')).toBe(0);
    });

    it('is marked exhausted at its next request, which then starts nothing', async () => {
      await request('4.4.4.4', () => cache.getOrSet('resolutions', fanOut(12), 3600));
      await settle();

      const next = await request('4.4.4.4', async () => currentUpstreamCaller());
      expect(next).toMatchObject({ ipKey: '4.4.4.4', exhausted: true });
      const { req, res } = exchange('4.4.4.4');
      let seen: unknown;
      await passthroughRateLimiter(req, res, () => {
        seen = currentUpstreamCaller();
      });
      expect(seen).toMatchObject({ exhausted: true });
    });

    it('keeps the decision for the whole request: an in-flight recompute is not cut short when the counter crosses', async () => {
      // Two shared keys recomputed one after the other by one request.
      const result = await request('4.4.4.4', async () => {
        const first = await cache.getOrSet('first', fanOut(4), 3600);
        const second = await cache.getOrSet('second', fanOut(4), 3600);
        return [first, second];
      });
      expect(fetchMock).toHaveBeenCalledTimes(8);
      expect(result.flat().every((read) => read !== undefined)).toBe(true);
    });

    it('counts the refresh of a live key it triggers while its request is open', async () => {
      // A live key with a recent last copy, expired: the refresh starts and the reader waits a moment for it.
      await cache.getOrSet('live', async () => 'old', 15);
      mockRedis.store.delete('live');
      let refreshed = false;
      const value = await request('4.4.4.4', () =>
        cache.getOrSet('live', async () => {
          await client.read('/during');
          refreshed = true;
          return 'new';
        }, 15, { refreshInBackground: true })
      );
      expect(refreshed).toBe(true);
      expect(value).toBe('new');
      await settle();
      expect(counted('4.4.4.4')).toBe(1);
    });
  });

  describe('a caller over budget on entry', () => {
    beforeEach(() => {
      exhaust('6.6.6.6');
    });

    it('is served a cache hit', async () => {
      mockRedis.store.set('hit', JSON.stringify({ v: 1 }));
      const fetchFn = jest.fn(async () => ({ v: 2 }));
      await expect(request('6.6.6.6', () => cache.getOrSet('hit', fetchFn, 60))).resolves.toEqual({ v: 1 });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('joins a recompute already running in this process', async () => {
      const fetchFn = jest.fn(() => later('shared', 60));
      const running = cache.getOrSet('joined', fetchFn, 60);
      await later(null, 10);
      const joiner = request('6.6.6.6', () => cache.getOrSet('joined', fetchFn, 60));
      await expect(Promise.all([running, joiner])).resolves.toEqual(['shared', 'shared']);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('is served the last copy of a missed key, and starts no recompute and writes no marker', async () => {
      await cache.getOrSet('copy', async () => 'old', 120);
      mockRedis.store.delete('copy'); // expired, its last copy is still there
      mockRedis.set.mockClear();
      const fetchFn = jest.fn(async () => 'new');

      const read = await request('6.6.6.6', () => cache.getOrSetWithMeta('copy', fetchFn, 120));
      expect(read).toEqual({ data: 'old', stale: true });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(failMarkers()).toEqual([]);

      // The next visitor, within budget, recomputes the key.
      await expect(cache.getOrSet('copy', fetchFn, 120)).resolves.toBe('new');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('gets its refusal for a missed key without a copy, leaving no marker and no result', async () => {
      const fetchFn = jest.fn(fanOut(12));
      const refusal = await request('6.6.6.6', () => cache.getOrSet('cold', fetchFn, 3600)).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(UpstreamBudgetExceededError);
      expect((refusal as UpstreamBudgetExceededError).retryAfterS).toBeGreaterThanOrEqual(1);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(failMarkers()).toEqual([]);
      expect(mockRedis.store.has('cold')).toBe(false);

      // A visitor within budget then computes the whole thing.
      const value = await cache.getOrSet('cold', fanOut(12), 3600);
      expect(value.every((read) => read !== undefined)).toBe(true);
    });

    it('does not start the background refresh of a live key, and is served the copy', async () => {
      await cache.getOrSet('live', async () => 'old', 15);
      mockRedis.store.delete('live');
      const fetchFn = jest.fn(async () => 'new');

      await expect(request('6.6.6.6', () => cache.getOrSetWithMeta('live', fetchFn, 15))).resolves.toMatchObject({ data: 'old' });
      await later(null, 30);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(mockRedis.locks.has('lock:live')).toBe(false);

      // Another visitor's read does start it.
      await cache.getOrSetWithMeta('live', fetchFn, 15);
      await later(null, 30);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('is served the old value of an aggregate and does not refresh it; a cold one is refused', async () => {
      const compute = jest.fn(async () => 'agg');
      mockRedis.store.set('agg:swr', JSON.stringify({ at: Date.now() - 120_000, value: 'old agg' }));
      await expect(request('6.6.6.6', () => cache.getOrRefresh('agg', compute, 60, 3600))).resolves.toBe('old agg');
      await later(null, 20);
      expect(compute).not.toHaveBeenCalled();
      expect(mockRedis.locks.has('lock:agg:swr')).toBe(false);

      await expect(request('6.6.6.6', () => cache.getOrRefresh('cold-agg', compute, 60, 3600))).rejects.toBeInstanceOf(
        UpstreamBudgetExceededError
      );
      expect(compute).not.toHaveBeenCalled();
    });

    it('is refused, with Redis unusable, unless it can join a direct fetch already running', async () => {
      mockRedis.healthy = false;
      // Redis unusable: the budget is read from the in-memory counters.
      for (let i = 0; i < 5; i++) countUpstreamCall('6.6.6.5');
      const fetchFn = jest.fn(() => later('direct', 60));
      await expect(request('6.6.6.5', () => cache.getOrSet('d', fetchFn, 60))).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
      expect(fetchFn).not.toHaveBeenCalled();

      const running = cache.getOrSet('d', fetchFn, 60);
      await later(null, 10);
      const joiner = request('6.6.6.5', () => cache.getOrSet('d', fetchFn, 60));
      await expect(Promise.all([running, joiner])).resolves.toEqual(['direct', 'direct']);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('is refused an aggregate with Redis unusable instead of computing it uncached', async () => {
      mockRedis.healthy = false;
      for (let i = 0; i < 5; i++) countUpstreamCall('6.6.6.4');
      const compute = jest.fn(async () => 'agg');
      await expect(request('6.6.6.4', () => cache.getOrRefresh('agg', compute, 60, 3600))).rejects.toBeInstanceOf(
        UpstreamBudgetExceededError
      );
      expect(compute).not.toHaveBeenCalled();
      // Within budget, it is computed as before.
      await expect(cache.getOrRefresh('agg', compute, 60, 3600)).resolves.toBe('agg');
    });

    it('is refused by withRedisCache on a miss before the fetcher starts, and served its hits', async () => {
      const fetcher = jest.fn(async () => ({ fetched: true }));
      await expect(request('6.6.6.6', () => withRedisCache('wrc:miss', 60, fetcher))).rejects.toBeInstanceOf(
        UpstreamBudgetExceededError
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(mockRedis.store.has('wrc:miss')).toBe(false);

      mockRedis.store.set('wrc:hit', JSON.stringify({ cached: true }));
      await expect(request('6.6.6.6', () => withRedisCache('wrc:hit', 60, fetcher))).resolves.toEqual({ cached: true });
      // Within budget, the same miss goes through.
      await expect(withRedisCache('wrc:miss', 60, fetcher)).resolves.toEqual({ fetched: true });
    });

    it('is refused an uncached client call with nothing left in flight', async () => {
      await expect(request('6.6.6.6', () => client.read('/uncached'))).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
      expect(fetchMock).not.toHaveBeenCalled();
      // A visitor from another IP then starts the same call normally.
      await expect(request('7.7.7.7', () => client.read('/uncached'))).resolves.toEqual(['row']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
