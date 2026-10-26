/**
 * Per-address indexer routes (HIP-3 users, vaults, builders, HIP-4 fills of a
 * user): any address is a fresh cache key and a billed HypeDexer call, so
 * each sits behind the per-address budget (BK-L-24), like wallet fills and
 * TWAPs. The real limiters run here with a lowered burst and Redis reported
 * down (the in-memory fallback counts at the limiter's own burst), so a
 * route that loses the middleware stops answering 429.
 */
process.env.INDEXER_ADDRESS_RATE_LIMIT_BURST = '3';

import express from 'express';
import request from 'supertest';

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => false,
    getClient: () => {
      throw new Error('Redis is down');
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Every service method answers an empty payload: only the middleware is under test.
const anyService = () =>
  new Proxy({}, { get: () => jest.fn().mockResolvedValue({ rows: [], data: [], meta: {} }) });
jest.mock('../../../src/services/indexer/indexer-hip3.service', () => ({
  IndexerHip3Service: { getInstance: anyService },
}));
jest.mock('../../../src/services/indexer/indexer-vaults-indexer.service', () => ({
  IndexerVaultsIndexerService: { getInstance: anyService },
}));
jest.mock('../../../src/services/indexer/indexer-builders-indexer.service', () => ({
  IndexerBuildersIndexerService: { getInstance: anyService },
}));
jest.mock('../../../src/services/indexer/indexer-hip4.service', () => ({
  IndexerHip4Service: { getInstance: anyService },
}));

import hip3Router from '../../../src/routes/indexer/hip3.routes';
import vaultsRouter from '../../../src/routes/indexer/vaults-indexer.routes';
import buildersRouter from '../../../src/routes/indexer/builders-indexer.routes';
import hip4Router from '../../../src/routes/indexer/hip4.routes';

const ADDR = '0x' + 'ab'.repeat(20);

function buildApp() {
  const app = express();
  app.use('/indexer/hip3', hip3Router);
  app.use('/indexer/vaults', vaultsRouter);
  app.use('/indexer/builders', buildersRouter);
  app.use('/indexer/hip4', hip4Router);
  return app;
}

/** [label, path, query] of requests that name an address. */
const ADDRESS_REQUESTS: [string, string, Record<string, string>][] = [
  ['hip3 user coins', `/indexer/hip3/users/${ADDR}/coins`, {}],
  ['hip3 user fills', `/indexer/hip3/users/${ADDR}/fills`, {}],
  ['hip3 user overview', `/indexer/hip3/users/${ADDR}/overview`, {}],
  ['hip3 fills of a user', '/indexer/hip3/fills', { user: ADDR }],
  ['vault details', '/indexer/vaults/vaultDetails', { vaultAddress: ADDR }],
  ['user vault equities', '/indexer/vaults/userVaultEquities', { user: ADDR }],
  ['vault daily snapshots', '/indexer/vaults/dailySnapshots', { vaultAddress: ADDR }],
  ['vault equity snapshots', '/indexer/vaults/equitySnapshots', { vaultAddress: ADDR }],
  ['vault ledger', '/indexer/vaults/vaultLedger', { vaultAddress: ADDR }],
  ['builder stats', `/indexer/builders/${ADDR}/stats`, {}],
  ['builder users', `/indexer/builders/${ADDR}/users`, {}],
  ['hip4 fills of a user', '/indexer/hip4/fills', { user: ADDR }],
];

/** Requests that share a route with the above but name no address, or never did. */
const MARKET_WIDE_REQUESTS: [string, string, Record<string, string>][] = [
  ['hip3 fills of a market', '/indexer/hip3/fills', { coin: 'xyz:AAPL' }],
  ['hip3 leaderboard', '/indexer/hip3/leaderboard', {}],
  ['vault summaries', '/indexer/vaults/vaultSummaries', {}],
  ['vault leaderboard', '/indexer/vaults/leaderboards/outflows', {}],
  ['hip4 fills of a market', '/indexer/hip4/fills', { coin: '#10' }],
];

describe('per-address indexer budget (BK-L-24)', () => {
  let now = Date.parse('2026-10-26T10:00:00.000Z');

  beforeEach(() => {
    // The fallback counters live in the module: move on a minute so every
    // case starts in a fresh one-second window.
    now += 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(ADDRESS_REQUESTS)('%s answers 429 with Retry-After past the per-address burst', async (_label, path, query) => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get(path).query(query);
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).get(path).query(query);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    // The window rolls over: the same route answers again.
    now += 1001;
    expect((await request(app).get(path).query(query)).status).toBe(200);
  });

  it('shares one counter across the address routes of an IP', async () => {
    const app = buildApp();
    for (const [, path, query] of ADDRESS_REQUESTS.slice(0, 3)) {
      expect((await request(app).get(path).query(query)).status).toBe(200);
    }
    const [, path, query] = ADDRESS_REQUESTS[4];
    expect((await request(app).get(path).query(query)).status).toBe(429);
  });

  it.each(MARKET_WIDE_REQUESTS)('%s never spends the per-address budget', async (_label, path, query) => {
    const app = buildApp();
    for (let i = 0; i < 6; i++) {
      expect((await request(app).get(path).query(query)).status).toBe(200);
    }
  });
});
