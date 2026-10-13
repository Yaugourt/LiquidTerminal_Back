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

import { marketRateLimiter, passthroughRateLimiter } from '../../../src/middleware/apiRateLimiter';

type Limiter = (req: Request, res: Response, next: NextFunction) => Promise<void>;

let lastRetryAfter: string | undefined;

async function hit(limiter: Limiter, ip: string): Promise<number> {
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
  } as unknown as Response;
  await limiter({ ip, path: '/x' } as Request, res, () => undefined);
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
});
