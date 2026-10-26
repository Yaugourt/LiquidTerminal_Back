/**
 * GET /active-users takes only the windows the site offers (1, 4, 12, 24 and
 * 168 hours, at most 100 rows): any other value would be an uncached billed
 * HypeDexer call per request. The polled windows keep coming from the
 * poller's Redis keys; 168 is one shared on-demand read for every visitor.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

const mockRedis = {
  store: new Map<string, string>(),
  locks: new Set<string>(),
  isHealthy: () => true,
  get: jest.fn(async (key: string) => mockRedis.store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string) => {
    mockRedis.store.set(key, value);
  }),
  delete: jest.fn(async (key: string) => {
    mockRedis.locks.delete(key);
    mockRedis.store.delete(key);
  }),
  publish: jest.fn(async () => 1),
  getClient: () => ({
    set: async (key: string) => {
      if (mockRedis.locks.has(key)) return null;
      mockRedis.locks.add(key);
      return 'OK';
    },
    exists: async (key: string) => (mockRedis.locks.has(key) ? 1 : 0),
  }),
};
jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const pass = (_req: Request, _res: Response, next: NextFunction) => next();
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
  countUpstreamCall: jest.fn(),
}));

import activeUsersRouter from '../../../src/routes/activeusers/activeusers.routes';
import { activeUsersQuerySchema } from '../../../src/schemas/activeusers.schema';

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    user: `0x${String(i).padStart(40, '0')}`,
    fill_count: 100 - i,
    total_volume: 1000 - i,
    unique_coins: 3,
    last_activity: '2026-10-26T10:00:00',
  }));
const envelope = (n: number) => ({
  success: true,
  message: '',
  data: rows(n),
  total_count: n,
  execution_time_ms: 1,
  next_cursor: null,
  has_more: false,
});

function buildApp() {
  const app = express();
  app.use('/active-users', activeUsersRouter);
  return app;
}

describe('GET /active-users windows', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.locks.clear();
    fetchMock = jest.fn(
      async () => new Response(JSON.stringify(envelope(100)), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('validation', () => {
    it.each([['0'], ['2'], ['6'], ['48'], ['100'], ['169'], ['1000'], ['abc'], ['2.5']])(
      'answers 400 for hours=%s, without an upstream call',
      async (hours) => {
        const res = await request(buildApp()).get('/active-users').query({ hours });
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it.each([['0'], ['101'], ['5000']])('answers 400 for limit=%s', async (limit) => {
      const res = await request(buildApp()).get('/active-users').query({ hours: '24', limit });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts every window the site offers, and the defaults', () => {
      const ok = (query: unknown) => activeUsersQuerySchema.safeParse({ query, params: {} }).success;
      for (const hours of ['1', '4', '12', '24', '168']) expect(ok({ hours, limit: '100' })).toBe(true);
      expect(ok({})).toBe(true);
      expect(ok({ limit: '1' })).toBe(true);
    });
  });

  describe('the 7-day window', () => {
    it('reads HypeDexer once for many requests, whatever their limit', async () => {
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) => request(buildApp()).get('/active-users').query({ hours: '168', limit: String(1 + (i % 100)) }))
      );
      // And again, after the burst.
      await request(buildApp()).get('/active-users').query({ hours: '168', limit: '100' });

      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The one read asks for 100 rows, the answer is sliced to the limit.
      expect(String(fetchMock.mock.calls[0][0])).toContain('/users/active?hours=168&limit=100');
      const lengths = responses.map((r) => r.body.data.length);
      expect(lengths).toEqual(Array.from({ length: 30 }, (_, i) => 1 + (i % 100)));
      expect(responses[0].body.metadata).toMatchObject({ hours: 168, limit: 1 });
    });

    it('is not mixed up with the polled windows', async () => {
      await request(buildApp()).get('/active-users').query({ hours: '168' });
      expect(mockRedis.store.has('activeusers:24h')).toBe(false);
      expect(mockRedis.store.has('activeusers:168h')).toBe(true);
    });
  });

  describe('the polled windows', () => {
    it.each([1, 4, 12, 24])('serve hours=%s from the poller key, sliced to the limit, with no upstream call', async (hours) => {
      mockRedis.store.set(`activeusers:${hours}h`, JSON.stringify(envelope(100)));
      const res = await request(buildApp()).get('/active-users').query({ hours: String(hours), limit: '10' });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(10);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('default to 24 hours and 100 rows', async () => {
      mockRedis.store.set('activeusers:24h', JSON.stringify(envelope(100)));
      const res = await request(buildApp()).get('/active-users');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(100);
      expect(res.body.metadata).toMatchObject({ hours: 24, limit: 100 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still refresh all four on a cold key, as before', async () => {
      const res = await request(buildApp()).get('/active-users').query({ hours: '4', limit: '5' });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(5);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
