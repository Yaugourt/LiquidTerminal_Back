/**
 * elysiumRpcRateLimiter on its Redis path: one request weighs what its
 * JSON-RPC calls weigh together, in both windows, in a single round trip.
 */
import type { NextFunction, Request, Response } from 'express';

const mockRedis = { counters: new Map<string, number>(), ttls: new Map<string, number>(), execCalls: 0 };

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => true,
    getClient: () => {
      const ops: (() => [Error | null, unknown])[] = [];
      const add = (key: string, by: number) => {
        ops.push(() => {
          const next = (mockRedis.counters.get(key) ?? 0) + by;
          mockRedis.counters.set(key, next);
          return [null, next];
        });
        return pipeline;
      };
      const pipeline = {
        incr: (key: string) => add(key, 1),
        incrby: (key: string, by: number) => add(key, by),
        expire: (key: string, seconds: number) => {
          ops.push(() => {
            mockRedis.ttls.set(key, seconds);
            return [null, 1];
          });
          return pipeline;
        },
        exec: async () => {
          mockRedis.execCalls += 1;
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

import { elysiumRpcRateLimiter } from '../../../src/middleware/apiRateLimiter';

const call = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] };

async function hit(body: unknown, ip = '203.0.113.7'): Promise<{ status: number; retryAfter?: string }> {
  let status = 200;
  let retryAfter: string | undefined;
  const res = {
    setHeader(name: string, value: string) {
      if (name === 'Retry-After') retryAfter = value;
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
  const next: NextFunction = () => undefined;
  await elysiumRpcRateLimiter({ ip, path: '/', body } as Request, res, next);
  return { status, retryAfter };
}

describe('elysiumRpcRateLimiter (Redis path)', () => {
  let now = Date.parse('2026-11-10T10:00:00.000Z');

  beforeEach(() => {
    now += 3_600_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockRedis.counters.clear();
    mockRedis.ttls.clear();
    mockRedis.execCalls = 0;
  });

  afterEach(() => jest.restoreAllMocks());

  const counts = (): number[] => [...mockRedis.counters.values()];

  it('adds the batch size to both windows in one round trip', async () => {
    expect((await hit(Array.from({ length: 20 }, () => call))).status).toBe(200);
    expect(counts()).toEqual([20, 20]);
    expect((await hit(call)).status).toBe(200);
    expect(counts()).toEqual([21, 21]);
    expect(mockRedis.execCalls).toBe(2);
    expect([...mockRedis.counters.keys()].every((k) => k.startsWith('ratelimit:elyrpc:203.0.113.7:'))).toBe(true);
  });

  it('adds the weight of the calls: a simulation its number of calls, a whole second at most, its full weight in the minute', async () => {
    const tx = { to: '0x' + '22'.repeat(20), data: '0x' };
    const simulate = (calls: number, blocks = 1) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_simulateV1',
      params: [{ blockStateCalls: Array.from({ length: blocks }, () => ({ calls: Array.from({ length: calls }, () => tx) })) }, 'latest'],
    });
    expect((await hit(simulate(40))).status).toBe(200);
    expect(counts()).toEqual([40, 40]);
    // 256 simulated calls would be refused for good at 256 in the second: they take the whole second, 50,
    // and their full weight in the minute.
    now += 1000;
    expect((await hit(simulate(64, 4), '203.0.113.9')).status).toBe(200);
    const mine = (): number[] => [...mockRedis.counters.entries()].filter(([k]) => k.includes('203.0.113.9')).map(([, v]) => v);
    expect(mine()).toEqual([50, 256]);
    // And it does take the second: the same client's next call waits for the next one.
    expect((await hit(call, '203.0.113.9')).status).toBe(429);
    // Four of them a minute: the fifth passes the 1,200 of the minute, in whatever second it comes.
    for (let i = 0; i < 3; i++) {
      now += 1000;
      expect((await hit(simulate(64, 4), '203.0.113.9')).status).toBe(200);
    }
    now += 1000;
    expect((await hit(simulate(64, 4), '203.0.113.9')).status).toBe(429);
    // A batch of 20 such simulations weighs the whole minute: admitted alone at the start of one, once.
    now += 60_000 - 5000;
    expect((await hit(Array.from({ length: 20 }, () => simulate(64, 4)), '203.0.113.9')).status).toBe(200);
    now += 1000;
    expect((await hit(call, '203.0.113.9')).status).toBe(429);
    // The other cases start on a whole minute.
    now -= 60_000 + 1000;
  });

  it('refuses past 50 calls in a second, whatever the number of requests', async () => {
    expect((await hit(Array.from({ length: 20 }, () => call))).status).toBe(200);
    expect((await hit(Array.from({ length: 20 }, () => call))).status).toBe(200);
    expect((await hit(Array.from({ length: 10 }, () => call))).status).toBe(200);
    const refused = await hit(call);
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe('1');
  });

  it('refuses past 1,200 calls in a minute', async () => {
    // 60 batches of 20, each in its own second of the same minute.
    for (let i = 0; i < 59; i++) {
      expect((await hit(Array.from({ length: 20 }, () => call))).status).toBe(200);
      now += 1000;
    }
    expect((await hit(Array.from({ length: 20 }, () => call))).status).toBe(200);
    now += 100;
    const refused = await hit(call);
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    // Another client is not affected.
    expect((await hit(call, '203.0.113.8')).status).toBe(200);
  });
});
