/**
 * Ensures GET /indexer/* passes validateGetRequest (no Zod error path "body").
 * Indexer domain services are mocked so requests do not call HypeDexer.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

/** Bypass Redis and rate-limit timers for this smoke suite */
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(),
  },
}));

function createMockIndexerServiceInstance(): Record<string, jest.Mock> {
  const cache: Record<string, jest.Mock> = {};
  return new Proxy({} as Record<string, jest.Mock>, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') {
        return undefined;
      }
      if (!cache[prop]) {
        cache[prop] = jest.fn().mockResolvedValue({});
      }
      return cache[prop];
    },
  });
}

const mockGetInstance = jest.fn(() => createMockIndexerServiceInstance());

jest.mock('../../../src/services/indexer/indexer-fills.service', () => ({
  IndexerFillsService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-overview.service', () => ({
  IndexerOverviewService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-analytics.service', () => ({
  IndexerAnalyticsService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-builders-indexer.service', () => ({
  IndexerBuildersIndexerService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-completed-trades.service', () => ({
  IndexerCompletedTradesService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-funding.service', () => ({
  IndexerFundingService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-hip3.service', () => ({
  IndexerHip3Service: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-spot-indexer.service', () => ({
  IndexerSpotIndexerService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-users.service', () => ({
  IndexerUsersService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-twaps.service', () => ({
  IndexerTwapsService: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/indexer/indexer-vaults-indexer.service', () => ({
  IndexerVaultsIndexerService: { getInstance: mockGetInstance },
}));

import indexerRoutes from '../../../src/routes/indexer';

function hasBodyValidationError(body: unknown): boolean {
  if (
    typeof body === 'object' &&
    body !== null &&
    'details' in body &&
    Array.isArray((body as { details: unknown }).details)
  ) {
    return (body as { details: Array<{ path?: string }> }).details.some(
      (d) => d.path === 'body'
    );
  }
  return false;
}

describe('Indexer GET validation smoke', () => {
  const app = express();
  app.use('/indexer', indexerRoutes);

  const paths: string[] = [
    '/indexer/fills/recent',
    '/indexer/fills/count',
    '/indexer/analytics/fills/stats',
    '/indexer/analytics/priority-fees/stats',
    '/indexer/overview/active-traders-24h',
    '/indexer/hip3/overview',
    '/indexer/hip3/priority-fees/gossip/status',
    '/indexer/hip3/priority-fees/gossip/history',
    '/indexer/spot/pairs',
    '/indexer/builders/list',
    '/indexer/funding/predictedFundings',
    '/indexer/completed-trades/summary',
    '/indexer/twaps/stats',
    '/indexer/vaults/vaultSummaries',
    '/indexer/vaults/leaderboards/followers-gained',
    '/indexer/vaults/leaderboards/outflows',
    '/indexer/users/leaderboard',
  ];

  it.each(paths)('%s — no Zod body validation failure', async (path) => {
    const res = await request(app).get(path);
    expect(hasBodyValidationError(res.body)).toBe(false);
  });

  it.each(paths)('%s — succeeds with mocked upstream', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });
});

/** OpenAPI-required query: see docs/hypedexer-required-query.json */
const VALID_ETH = '0x1111111111111111111111111111111111111111';

describe('Indexer required query params (OpenAPI alignment)', () => {
  const app = express();
  app.use('/indexer', indexerRoutes);

  it('returns 400 when /vaults/userVaultEquities is missing required user', async () => {
    const res = await request(app).get('/indexer/vaults/userVaultEquities');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Validation Error' });
  });

  it('returns 200 when /vaults/userVaultEquities includes user', async () => {
    const res = await request(app).get(
      `/indexer/vaults/userVaultEquities?user=${encodeURIComponent(VALID_ETH)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('returns 400 when /overview/coin-distribution is missing required user', async () => {
    const res = await request(app).get('/indexer/overview/coin-distribution');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Validation Error' });
  });

  it('returns 200 when /overview/coin-distribution includes user', async () => {
    const res = await request(app).get(
      `/indexer/overview/coin-distribution?user=${encodeURIComponent(VALID_ETH)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });
});
