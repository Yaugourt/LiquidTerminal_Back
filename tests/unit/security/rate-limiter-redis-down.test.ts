jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => false,
    getClient: () => {
      throw new Error('getClient must not be called while the circuit is open');
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import type { NextFunction, Request, Response } from 'express';
import { addressLookupRateLimiter, marketRateLimiter } from '../../../src/middleware/apiRateLimiter';

function run(limiter: (req: Request, res: Response, next: NextFunction) => Promise<void>, ip: string, n: number) {
  let passed = 0;
  let limited = 0;
  const res = { setHeader: () => undefined, status: () => ({ json: () => { limited++; } }) } as unknown as Response;
  return (async () => {
    for (let i = 0; i < n; i++) await limiter({ ip, path: '/x' } as Request, res, () => { passed++; });
    return { passed, limited };
  })();
}

describe('rate limiters with Redis down', () => {
  it('fall back to the in-memory limit instead of letting everything through', async () => {
    const r = await run(marketRateLimiter, '203.0.113.7', 250);
    expect(r.passed).toBe(200);
    expect(r.limited).toBe(50);
  });

  it('the address-lookup limiter also blocks a burst', async () => {
    const r = await run(addressLookupRateLimiter, '203.0.113.8', 100);
    expect(r.passed).toBeLessThan(100);
    expect(r.limited).toBeGreaterThan(0);
  });
});
