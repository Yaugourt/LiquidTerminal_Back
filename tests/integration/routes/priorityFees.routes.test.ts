/**
 * GET /market/priority-fees/series — window validation and the fan-out that
 * rebuilds a series out of cumulative rollups. The upstream client is mocked so
 * the suite never reaches HypeDexer.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  passthroughRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

const redisStore = new Map<string, string>();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
    }),
    getClient: jest.fn(),
  },
}));

const NOW = Date.UTC(2026, 6, 27, 16, 0, 0);
const HOUR_MS = 3_600_000;

/** Cumulative gas is 10 HYPE an hour, so every differenced bucket must be 10. */
const getPriorityFeesStats = jest.fn(async ({ hours }: { hours: number }) => ({
  total_priority_gas: hours * 10,
  total_fills_with_priority: hours * 100,
  avg_priority_gas: 0.1,
  min_priority_gas: 0.000001,
  max_priority_gas: 7.5,
  unique_users: 225,
  time_range: {
    start: new Date(NOW - hours * HOUR_MS).toISOString(),
    end: new Date(NOW).toISOString(),
  },
}));

const getFillsStats = jest.fn(async () => ({ total_fills: 9_000_000, unique_users: 65_000 }));

jest.mock('../../../src/clients/hypedexer/rest/analytics/analytics-indexer.client', () => ({
  HypeDexerAnalyticsIndexerClient: {
    getInstance: () => ({ getPriorityFeesStats, getFillsStats }),
  },
}));

import priorityFeesRoutes from '../../../src/routes/priorityFees/priorityFees.routes';

function buildApp() {
  const app = express();
  app.use('/market/priority-fees', priorityFeesRoutes);
  return app;
}

describe('GET /market/priority-fees/series', () => {
  beforeEach(() => {
    redisStore.clear();
    getPriorityFeesStats.mockClear();
    getFillsStats.mockClear();
  });

  it('rejects a window the upstream cannot serve', async () => {
    const res = await request(buildApp()).get('/market/priority-fees/series?window=30d');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_WINDOW');
  });

  it('defaults to the last day', async () => {
    const res = await request(buildApp()).get('/market/priority-fees/series');

    expect(res.status).toBe(200);
    expect(res.body.data.window).toBe('24h');
  });

  it('returns one hourly bucket per hour of the day', async () => {
    const res = await request(buildApp()).get('/market/priority-fees/series?window=24h');

    expect(res.status).toBe(200);
    const { buckets, bucketSeconds, meta } = res.body.data;
    expect(bucketSeconds).toBe(3600);
    expect(buckets).toHaveLength(24);
    expect(meta.missingBuckets).toBe(0);
    buckets.forEach((b: { gas: number; fills: number }) => {
      expect(b.gas).toBeCloseTo(10, 8);
      expect(b.fills).toBe(100);
    });
  });

  it('carries the aggregates differencing cannot produce, plus the venue denominators', async () => {
    const res = await request(buildApp()).get('/market/priority-fees/series?window=24h');

    const { totals } = res.body.data;
    // Straight from the widest rollup, never summed across buckets.
    expect(totals.uniqueUsers).toBe(225);
    expect(totals.maxGas).toBe(7.5);
    expect(totals.gas).toBeCloseTo(240, 8);
    expect(totals.allFills).toBe(9_000_000);
    expect(totals.allUsers).toBe(65_000);
  });

  it('steps the week in six-hour buckets and stops at the upstream ceiling', async () => {
    const res = await request(buildApp()).get('/market/priority-fees/series?window=7d');

    const { buckets, bucketSeconds, meta } = res.body.data;
    expect(bucketSeconds).toBe(21_600);
    expect(buckets).toHaveLength(28);
    expect(meta.maxWindowHours).toBe(168);
    const requested = getPriorityFeesStats.mock.calls.map((c) => c[0].hours);
    expect(Math.max(...requested)).toBe(168);
  });

  it('serves the second request from cache instead of fanning out again', async () => {
    const app = buildApp();
    await request(app).get('/market/priority-fees/series?window=24h');
    const afterFirst = getPriorityFeesStats.mock.calls.length;

    await request(app).get('/market/priority-fees/series?window=24h');
    expect(getPriorityFeesStats.mock.calls.length).toBe(afterFirst);
  });

  it('still answers when some rollups fail, and says how many were lost', async () => {
    getPriorityFeesStats.mockImplementationOnce(async () => {
      throw new Error('upstream 502');
    });

    const res = await request(buildApp()).get('/market/priority-fees/series?window=24h');

    expect(res.status).toBe(200);
    expect(res.body.data.meta.missingBuckets).toBe(1);
    expect(res.body.data.buckets.length).toBe(23);
  });

  it('fails with an upstream error when nothing can be fetched', async () => {
    getPriorityFeesStats.mockImplementation(async () => {
      throw new Error('upstream down');
    });

    const res = await request(buildApp()).get('/market/priority-fees/series?window=24h');

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PRIORITY_FEES_SERIES_ERROR');
  });
});
