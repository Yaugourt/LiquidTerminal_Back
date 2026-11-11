/**
 * marketRateLimiter / passthroughRateLimiter: fixed-window counters in one
 * Redis round trip, and a real in-memory fallback when Redis fails (the old
 * code swallowed the error, counted 0 and let every request through). The
 * limits are per IP and sized for many visitors behind one address (CGNAT,
 * offices); a refusal tells the client to retry once the window that refused
 * it rolls over.
 */
import type { NextFunction, Request, Response } from 'express';

const mockRedis = {
  counters: new Map<string, number>(),
  ttls: new Map<string, number>(),
  fail: null as 'reject' | 'command' | null,
  execCalls: 0,
};

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => true,
    getClient: () => {
      const ops: (() => [Error | null, unknown])[] = [];
      const pipeline = {
        incr: (key: string) => {
          ops.push(() => {
            const next = (mockRedis.counters.get(key) ?? 0) + 1;
            mockRedis.counters.set(key, next);
            return [null, next];
          });
          return pipeline;
        },
        expire: (key: string, seconds: number) => {
          ops.push(() => {
            mockRedis.ttls.set(key, seconds);
            return [null, 1];
          });
          return pipeline;
        },
        exec: async () => {
          mockRedis.execCalls += 1;
          if (mockRedis.fail === 'reject') throw new Error("Stream isn't writeable");
          if (mockRedis.fail === 'command') return ops.map(() => [new Error('OOM'), null]);
          return ops.map((op) => op());
        },
      };
      return { pipeline: () => pipeline };
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  indexerAddressQueryRateLimiter,
  indexerAddressRateLimiter,
  marketRateLimiter,
  passthroughRateLimiter,
} from '../../../src/middleware/apiRateLimiter';

type Limiter = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

let lastRetryAfter: string | undefined;

async function hit(limiter: Limiter, ip: string, query: Record<string, unknown> = {}): Promise<number> {
  let status = 200;
  const res = {
    setHeader(name: string, value: string) {
      if (name === 'Retry-After') lastRetryAfter = value;
      return this;
    },
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
    // Admitted passthrough requests listen for the end of the response.
    once() {
      return this;
    },
  } as unknown as Response;
  await limiter({ ip, path: '/x', query } as Request, res, () => undefined);
  return status;
}

async function burst(limiter: Limiter, ip: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) statuses.push(await hit(limiter, ip));
  return statuses;
}

describe('rate limiters', () => {
  let now: number;

  beforeEach(() => {
    mockRedis.counters.clear();
    mockRedis.ttls.clear();
    mockRedis.fail = null;
    mockRedis.execCalls = 0;
    now = Date.parse('2026-09-24T10:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows 200 requests per second per IP, in one round trip each', async () => {
    const statuses = await burst(marketRateLimiter, '1.1.1.1', 201);
    expect(statuses.slice(0, 200).every((s) => s === 200)).toBe(true);
    expect(statuses[200]).toBe(429);
    // The one-second window rolls over in a second.
    expect(lastRetryAfter).toBe('1');
    expect(mockRedis.execCalls).toBe(201);
    // Another IP is unaffected, and the next second starts a new window.
    expect(await hit(marketRateLimiter, '2.2.2.2')).toBe(200);
    now += 1000;
    expect(await hit(marketRateLimiter, '1.1.1.1')).toBe(200);
  });

  it('enforces the per-minute ceiling across seconds and expires every key', async () => {
    const statuses: number[] = [];
    for (let second = 0; second < 31; second++) {
      statuses.push(...(await burst(marketRateLimiter, '3.3.3.3', 195)));
      now += 1000;
    }
    // 6000 allowed in the minute, then refused until the window rolls over,
    // which is what the client is told to wait (refused from 30 s in: 30 s left).
    expect(statuses.filter((s) => s === 200).length).toBe(6000);
    expect(statuses[6000]).toBe(429);
    expect(lastRetryAfter).toBe('30');
    // Every counter expires after twice its window.
    const expected: Record<string, number> = { burst: 2, minute: 120, hour: 7200 };
    for (const [key, ttl] of mockRedis.ttls) {
      expect(ttl).toBe(expected[key.split(':').slice(-2, -1)[0]]);
    }
  });

  it.each(['reject', 'command'] as const)('falls back to the in-memory limiter when Redis fails (%s)', async (mode) => {
    mockRedis.fail = mode;
    // The fallback counters live in the module: one IP per case.
    const statuses = await burst(marketRateLimiter, mode === 'reject' ? '4.4.4.4' : '6.6.6.6', 201);
    expect(statuses.slice(0, 200).every((s) => s === 200)).toBe(true);
    expect(statuses[200]).toBe(429);
  });

  /**
   * With Redis down the fallback kept the one-second window only: a client was held to its
   * burst and nothing else, every second of the outage (12,000 a minute against 6,000).
   */
  it('keeps the minute limit while Redis is down: the fallback counts every window', async () => {
    mockRedis.fail = 'reject';
    const statuses: number[] = [];
    for (let second = 0; second < 31; second++) {
      statuses.push(...(await burst(marketRateLimiter, '4.4.8.8', 195)));
      now += 1000;
    }
    expect(statuses.filter((s) => s === 200).length).toBe(6000);
    expect(statuses[6000]).toBe(429);
    // Told to come back when the minute rolls over, not in a second.
    expect(lastRetryAfter).toBe('30');
    now += 30_000;
    expect(await hit(marketRateLimiter, '4.4.8.8')).toBe(200);
  });

  it('keeps the pass-through minute limit while Redis is down (4,000, it was 18,000)', async () => {
    mockRedis.fail = 'reject';
    const statuses: number[] = [];
    for (let second = 0; second < 14; second++) {
      statuses.push(...(await burst(passthroughRateLimiter, '4.4.9.9', 290)));
      now += 1000;
    }
    expect(statuses.filter((s) => s === 200).length).toBe(4000);
    expect(statuses[4000]).toBe(429);
  });

  it('lets a page-load fan-out through the passthrough burst, with its own counters', async () => {
    const statuses = await burst(passthroughRateLimiter, '5.5.5.5', 301);
    expect(statuses.slice(0, 300).every((s) => s === 200)).toBe(true);
    expect(statuses[300]).toBe(429);
    // The general limiter's counters are separate.
    expect(await hit(marketRateLimiter, '5.5.5.5')).toBe(200);
  });

  it('caps passthrough traffic at 4000 per minute per IP', async () => {
    const statuses: number[] = [];
    for (let second = 0; second < 14; second++) {
      statuses.push(...(await burst(passthroughRateLimiter, '7.7.7.7', 290)));
      now += 1000;
    }
    expect(statuses.filter((s) => s === 200).length).toBe(4000);
    expect(statuses[4000]).toBe(429);
  });

  it('reads its limits from the environment', async () => {
    const saved = { ...process.env };
    process.env.RATE_LIMIT_BURST = '3';
    process.env.PASSTHROUGH_RATE_LIMIT_BURST = '2';
    try {
      let limiters: typeof import('../../../src/middleware/apiRateLimiter') | undefined;
      jest.isolateModules(() => {
        limiters = require('../../../src/middleware/apiRateLimiter');
      });
      expect(await burst(limiters!.marketRateLimiter, '8.8.8.8', 4)).toEqual([200, 200, 200, 429]);
      expect(await burst(limiters!.passthroughRateLimiter, '8.8.8.8', 3)).toEqual([200, 200, 429]);
    } finally {
      process.env = saved;
    }
  });

  describe('IPv6 clients share one budget per /64', () => {
    it.each([
      ['market', marketRateLimiter, 200],
      ['passthrough', passthroughRateLimiter, 300],
    ] as const)('%s limiter: addresses of one /64 share a counter, another /64 does not', async (_name, limiter, max) => {
      const statuses = await burst(limiter, '2001:db8:1:2::1', max);
      expect(statuses.every((s) => s === 200)).toBe(true);
      // Any other address of the same /64 (full or compressed) is the same caller.
      expect(await hit(limiter, '2001:db8:1:2:dead:beef:0:99')).toBe(429);
      expect(await hit(limiter, '2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe(429);
      // A different /64 has its own budget.
      expect(await hit(limiter, '2001:db8:1:3::1')).toBe(200);
    });

    it('keeps IPv4 per address and maps IPv4-mapped IPv6 to its IPv4 address', async () => {
      await burst(marketRateLimiter, '9.9.9.9', 200);
      expect(await hit(marketRateLimiter, '9.9.9.9')).toBe(429);
      expect(await hit(marketRateLimiter, '::ffff:9.9.9.9')).toBe(429);
      expect(await hit(marketRateLimiter, '9.9.9.10')).toBe(200);
    });

    /**
     * The request limiters do not count the /48 a client sits in: a carrier shares a /48 between
     * thousands of strangers, and a count at that level is filled by anyone in it.
     */
    it.each([
      ['market', marketRateLimiter, 200],
      ['passthrough', passthroughRateLimiter, 300],
    ] as const)('%s limiter: a subnet that floods, or many subnets at their limit, never get a neighbour of their /48 refused', async (_name, limiter, max) => {
      // One subscriber far over its own limit: it is refused, its requests keep coming.
      const flood = await burst(limiter, '2001:db8:77:1::1', max * 20);
      expect(flood.filter((s) => s === 200)).toHaveLength(max);
      // Thirty other subnets of the same /48, each at its limit in the same second.
      for (let subnet = 2; subnet < 32; subnet++) {
        const statuses = await burst(limiter, `2001:db8:77:${subnet.toString(16)}::1`, max);
        expect(statuses.every((s) => s === 200)).toBe(true);
      }
      // A neighbour that has asked for nothing yet is served.
      expect(await hit(limiter, '2001:db8:77:ffff::1')).toBe(200);
      expect([...mockRedis.counters.keys()].some((k) => k.includes('/48'))).toBe(false);
    });

    it('applies the /64 key to the in-memory fallback too', async () => {
      mockRedis.fail = 'reject';
      const statuses = await burst(marketRateLimiter, '2001:db8:aaaa:1::1', 200);
      expect(statuses.every((s) => s === 200)).toBe(true);
      expect(await hit(marketRateLimiter, '2001:db8:aaaa:1::2')).toBe(429);
      expect(await hit(marketRateLimiter, '2001:db8:aaaa:2::1')).toBe(200);
    });
  });

  describe('indexer address limiter', () => {
    it('lets ten wallet pages open in one second and refuses the 61st call', async () => {
      // A wallet page makes 6 per-address indexer calls in its first second.
      const statuses = await burst(indexerAddressRateLimiter, '10.0.0.1', 61);
      expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
      expect(statuses[60]).toBe(429);
      // Its own counters: the general and passthrough budgets are untouched.
      expect(await hit(marketRateLimiter, '10.0.0.1')).toBe(200);
      expect(await hit(passthroughRateLimiter, '10.0.0.1')).toBe(200);
    });

    it('caps a sweep at 1200 a minute per IP (per /64 for IPv6)', async () => {
      const statuses: number[] = [];
      for (let second = 0; second < 21; second++) {
        statuses.push(...(await burst(indexerAddressRateLimiter, '2001:db8:bbbb:1::1', 58)));
        now += 1000;
      }
      expect(statuses.filter((s) => s === 200).length).toBe(1200);
      expect(await hit(indexerAddressRateLimiter, '2001:db8:bbbb:1::77')).toBe(429);
    });

    it('the query variant only counts requests that name a user', async () => {
      // Market-wide polls (no `user`) never spend the budget.
      for (let i = 0; i < 100; i++) expect(await hit(indexerAddressQueryRateLimiter, '10.0.0.2')).toBe(200);
      expect(await hit(indexerAddressQueryRateLimiter, '10.0.0.2', { user: '' })).toBe(200);
      const wallet = { user: '0x' + 'a'.repeat(40) };
      const named: number[] = [];
      for (let i = 0; i < 61; i++) named.push(await hit(indexerAddressQueryRateLimiter, '10.0.0.2', wallet));
      expect(named.slice(0, 60).every((s) => s === 200)).toBe(true);
      expect(named[60]).toBe(429);
    });
  });
});
