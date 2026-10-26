/**
 * A client refused by its own HypeDexer miss budget (UpstreamBudgetExceededError)
 * gets 429 + Retry-After on every passthrough route, not the route's generic
 * upstream error. Any other failure keeps the route's own status and body.
 * Covers a route with an inline catch (analytics), the send502 helpers of
 * hip3 and hip4, the 503 helper of hip4 and a route with a single catch (candles).
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';

const pass = (_req: Request, _res: Response, next: NextFunction) => next();
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
  passthroughRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
}));

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const analytics = { getFillsStats: jest.fn(), getPriorityFeesStats: jest.fn() };
jest.mock('../../../src/services/indexer/indexer-analytics.service', () => ({
  IndexerAnalyticsService: { getInstance: () => analytics },
}));
const hip3 = { getDexs: jest.fn() };
jest.mock('../../../src/services/indexer/indexer-hip3.service', () => ({
  IndexerHip3Service: { getInstance: () => hip3 },
}));
const hip4 = { getFills: jest.fn(), getResolutions: jest.fn() };
jest.mock('../../../src/services/indexer/indexer-hip4.service', () => ({
  IndexerHip4Service: { getInstance: () => hip4 },
}));
const candles = { getCandles: jest.fn() };
jest.mock('../../../src/clients/hypedexer/rest/candles/candles.client', () => ({
  CANDLE_INTERVALS: ['5s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d'],
  HypeDexerCandlesClient: { getInstance: () => candles },
}));

import analyticsRouter from '../../../src/routes/indexer/analytics.routes';
import candlesRouter from '../../../src/routes/indexer/candles.routes';
import hip3Router from '../../../src/routes/indexer/hip3.routes';
import hip4Router from '../../../src/routes/indexer/hip4.routes';

function buildApp() {
  const app = express();
  app.use('/indexer/analytics', analyticsRouter);
  app.use('/indexer/candles', candlesRouter);
  app.use('/indexer/hip3', hip3Router);
  app.use('/indexer/hip4', hip4Router);
  return app;
}

const refusal = () => new UpstreamBudgetExceededError(37);

const cases: Array<{ name: string; url: string; fail: (e: Error) => void; code: string; status: number; body: object }> = [
  {
    name: 'analytics (inline catch)',
    url: '/indexer/analytics/fills/stats',
    fail: (e) => analytics.getFillsStats.mockRejectedValue(e),
    status: 502,
    code: 'INDEXER_ANALYTICS_FILLS_STATS_ERROR',
    body: { success: false, error: 'Upstream error', code: 'INDEXER_ANALYTICS_FILLS_STATS_ERROR' },
  },
  {
    name: 'hip3 (send502)',
    url: '/indexer/hip3/dexs',
    fail: (e) => hip3.getDexs.mockRejectedValue(e),
    status: 502,
    code: 'INDEXER_HIP3_DEXS_ERROR',
    body: { success: false, error: 'Upstream error', code: 'INDEXER_HIP3_DEXS_ERROR' },
  },
  {
    name: 'hip4 (send502)',
    url: '/indexer/hip4/fills',
    fail: (e) => hip4.getFills.mockRejectedValue(e),
    status: 502,
    code: 'INDEXER_HIP4_FILLS_ERROR',
    body: { success: false, error: 'Upstream error', code: 'INDEXER_HIP4_FILLS_ERROR' },
  },
  {
    name: 'hip4 (send503)',
    url: '/indexer/hip4/resolutions',
    fail: (e) => hip4.getResolutions.mockRejectedValue(e),
    status: 503,
    code: 'INDEXER_HIP4_RESOLUTIONS_UNAVAILABLE',
    body: {
      success: false,
      error: 'HIP-4 resolutions temporarily unavailable',
      code: 'INDEXER_HIP4_RESOLUTIONS_UNAVAILABLE',
    },
  },
  {
    name: 'candles',
    url: `/indexer/candles?coin=BTC&interval=5s&startTime=${Date.now() - 3_600_000}`,
    fail: (e) => candles.getCandles.mockRejectedValue(e),
    status: 502,
    code: 'INDEXER_CANDLES_ERROR',
    body: { success: false, error: 'Candles unavailable', code: 'INDEXER_CANDLES_ERROR' },
  },
];

describe('a client over its HypeDexer budget', () => {
  beforeEach(() => {
    for (const m of [analytics.getFillsStats, hip3.getDexs, hip4.getFills, hip4.getResolutions, candles.getCandles]) {
      m.mockReset();
    }
  });

  it.each(cases)('$name: 429 + Retry-After + code instead of the upstream error', async (c) => {
    c.fail(refusal());

    const res = await request(buildApp()).get(c.url);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('37');
    expect(res.body).toEqual({
      error: 'Rate limit exceeded',
      message: 'Too many uncached indexer lookups, retry shortly',
      retryAfter: 37,
      code: 'UPSTREAM_BUDGET_EXCEEDED',
    });
  });

  it.each(cases)('$name: any other failure keeps the route status and body', async (c) => {
    c.fail(new Error('boom'));

    const res = await request(buildApp()).get(c.url);

    expect(res.status).toBe(c.status);
    expect(res.body).toEqual(c.body);
    if (c.status === 503) expect(res.headers['retry-after']).toBe('15');
    else expect(res.headers['retry-after']).toBeUndefined();
  });
});
