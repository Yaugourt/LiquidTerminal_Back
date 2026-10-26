/**
 * The REAL liquidations service behind the routes (only its client is mocked):
 * a client over its HypeDexer budget gets 429 + Retry-After + code
 * UPSTREAM_BUDGET_EXCEEDED, not the 500 the service used to wrap the refusal
 * into. A real upstream failure keeps its 500.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';

const pass = (_req: Request, _res: Response, next: NextFunction) => next();
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
  passthroughRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
  indexerAddressQueryRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
}));

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { isHealthy: () => true, get: jest.fn(async () => null), set: jest.fn(async () => undefined) },
}));
jest.mock('../../../src/repositories', () => ({ historicalLiquidationRepository: {} }));

const client = { getLiquidations: jest.fn(), getRecentLiquidations: jest.fn(), getAnalyticsStats: jest.fn() };
jest.mock('../../../src/clients/hypedexer/rest/liquidations/liquidations.client', () => ({
  HLIndexerLiquidationsClient: { getInstance: () => client },
}));
jest.mock('../../../src/services/liquidations/sse-manager.service', () => ({
  SSEManagerService: { getInstance: () => ({ setDataProvider: () => undefined, addClient: jest.fn(), getStats: jest.fn() }) },
}));
jest.mock('../../../src/services/liquidations/liquidations.ingestion.service', () => ({
  LiquidationsIngestionService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/liquidations/liquidations.backfill.service', () => ({
  LiquidationsBackfillService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/liquidations/liquidations.ws.service', () => ({
  LiquidationsWebSocketService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/websocket', () => ({ InternalWebSocketServer: { getInstance: () => ({}) } }));
jest.mock('../../../src/services/liquidations/liquidations.historical-stats.service', () => ({
  HistoricalStatsService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/liquidations/liquidations.historical-chart.service', () => ({
  HistoricalChartService: { getInstance: () => ({}) },
}));

import router from '../../../src/routes/liquidations/liquidations.routes';

function buildApp() {
  const app = express();
  app.use('/liquidations', router);
  return app;
}

const routes: Array<[string, string, jest.Mock]> = [
  ['list', '/liquidations', client.getLiquidations],
  ['recent', '/liquidations/recent?coin=BTC', client.getRecentLiquidations],
  ['analytics', '/liquidations/analytics/stats', client.getAnalyticsStats],
];

describe('liquidations routes with the real service, for a client over its budget', () => {
  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
  });

  it.each(routes)('%s: 429 + Retry-After + code, not a 500', async (_name, url, upstream) => {
    upstream.mockRejectedValue(new UpstreamBudgetExceededError(37));

    const res = await request(buildApp()).get(url);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('37');
    expect(res.body).toEqual({
      error: 'Rate limit exceeded',
      message: 'Too many uncached indexer lookups, retry shortly',
      retryAfter: 37,
      code: 'UPSTREAM_BUDGET_EXCEEDED',
    });
  });

  it.each(routes)('%s: a real upstream failure is still a 500', async (_name, url, upstream) => {
    upstream.mockRejectedValue(new Error('boom'));

    const res = await request(buildApp()).get(url);

    expect(res.status).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
  });
});
