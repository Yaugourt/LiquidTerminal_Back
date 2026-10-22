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
  passthroughRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  indexerAddressRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  indexerAddressQueryRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
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
jest.mock('../../../src/services/indexer/indexer-elysium.service', () => ({
  IndexerElysiumService: { getInstance: mockGetInstance },
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
    '/indexer/elysium/stats',
    '/indexer/elysium/stats/daily?days=30',
    '/indexer/elysium/blocks?limit=5',
    '/indexer/elysium/transactions?limit=5&include_spam=false&include_system=true',
    '/indexer/elysium/batches?limit=5',
    '/indexer/elysium/bridge/transfers?limit=5&direction=deposit&status=completed&route=canonical&asset=token',
    '/indexer/elysium/bridge/retryables?limit=5&status=redeemed',
    '/indexer/elysium/bridge/reserves?route=native&only_unbacked=false',
    '/indexer/elysium/bridge/tokens?limit=5&route=mirror',
    '/indexer/elysium/tokens?limit=5&standard=erc20&origin=native',
    '/indexer/elysium/user/0x1e4f06e89a0c4f0c47f42a78881c8ee357dd628e/balances',
    '/indexer/elysium/user/0x1e4f06e89a0c4f0c47f42a78881c8ee357dd628e/activity?limit=5&offset=10',
    '/indexer/elysium/user/0x1e4f06e89a0c4f0c47f42a78881c8ee357dd628e/bridge?limit=5&direction=deposit',
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

/** Every row is billed upstream: a `limit` past the cap must never reach a service. */
describe('Indexer limit caps', () => {
  const app = express();
  app.use('/indexer', indexerRoutes);

  const vault = `vaultAddress=${VALID_ETH}`;
  const capped: Array<[string, number]> = [
    ['/indexer/completed-trades/?', 1000],
    ['/indexer/hip3/fills?', 1000],
    ['/indexer/hip3/leaderboard?', 1000],
    ['/indexer/spot/pairs?', 1000],
    ['/indexer/twaps/?', 1000],
    ['/indexer/vaults/vaultSummaries?includeClosed=true&', 5000],
    [`/indexer/vaults/equitySnapshots?${vault}&`, 5000],
    [`/indexer/vaults/vaultLedger?${vault}&`, 10000],
  ];

  it.each(capped)('%s accepts limit=%i', async (path, max) => {
    const res = await request(app).get(`${path}limit=${max}`);
    expect(res.status).toBe(200);
  });

  it.each(capped)('%s rejects limit above %i', async (path, max) => {
    const res = await request(app).get(`${path}limit=${max + 1}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Validation Error' });
  });

  it('rejects a fractional limit', async () => {
    const res = await request(app).get('/indexer/twaps/?limit=10.5');
    expect(res.status).toBe(400);
  });
});

describe('Indexer Elysium query validation', () => {
  const app = express();
  app.use('/indexer', indexerRoutes);

  const invalid: string[] = [
    '/indexer/elysium/bridge/reserves',
    '/indexer/elysium/bridge/reserves?route=bogus',
    '/indexer/elysium/stats/daily?days=0',
    '/indexer/elysium/stats/daily?days=366',
    '/indexer/elysium/blocks?limit=101',
    '/indexer/elysium/transactions?include_spam=yes',
    '/indexer/elysium/batches?limit=51',
    '/indexer/elysium/bridge/transfers?direction=sideways',
    '/indexer/elysium/bridge/retryables?status=done',
    '/indexer/elysium/bridge/tokens?route=native',
    '/indexer/elysium/tokens?standard=erc777',
    '/indexer/elysium/user/0x123/balances',
    '/indexer/elysium/user/0x1e4f06e89a0c4f0c47f42a78881c8ee357dd628e/activity?limit=101',
    '/indexer/elysium/user/0x1e4f06e89a0c4f0c47f42a78881c8ee357dd628e/bridge?direction=up',
  ];

  it.each(invalid)('%s — returns 400', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Validation Error' });
  });
});
