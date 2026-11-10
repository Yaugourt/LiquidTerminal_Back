/**
 * Elysium list pass-through routes (/blocks, /transactions, /bridge/*, /tokens,
 * /stats*): the caller picks the cache key (limit, filters, network), so each
 * miss is a billed HypeDexer call. They sit behind the pass-through limiter,
 * which also makes the client the upstream caller (budget of billed calls,
 * BK-L-26), like every other /indexer route. The real limiters run here with
 * a lowered pass-through burst and Redis reported down (the in-memory fallback
 * counts at the limiter's own burst), so a route that loses the middleware
 * stops answering 429.
 */
process.env.PASSTHROUGH_RATE_LIMIT_BURST = '3';
process.env.ADDRESS_LOOKUP_RATE_LIMIT_BURST = '2';

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

/** True when the handler ran with its client as the upstream caller. */
const sawUpstreamCaller: boolean[] = [];
jest.mock('../../../src/services/indexer/indexer-elysium.service', () => {
  const { currentUpstreamCaller } = jest.requireActual('../../../src/utils/request-context');
  const answer = jest.fn(async () => {
    sawUpstreamCaller.push(currentUpstreamCaller() !== undefined);
    return [];
  });
  return { IndexerElysiumService: { getInstance: () => new Proxy({}, { get: () => answer }) } };
});

import elysiumRouter from '../../../src/routes/indexer/elysium.routes';

const ADDR = '0x' + 'ab'.repeat(20);

function buildApp() {
  const app = express();
  app.use('/indexer/elysium', elysiumRouter);
  return app;
}

const LIST_REQUESTS: [string, Record<string, string>][] = [
  ['/indexer/elysium/stats', {}],
  ['/indexer/elysium/stats/daily', { days: '30' }],
  ['/indexer/elysium/blocks', { limit: '20' }],
  ['/indexer/elysium/transactions', { limit: '20', network: 'mainnet' }],
  ['/indexer/elysium/batches', {}],
  ['/indexer/elysium/bridge/transfers', { direction: 'deposit' }],
  ['/indexer/elysium/bridge/retryables', {}],
  ['/indexer/elysium/bridge/reserves', { route: 'native' }],
  ['/indexer/elysium/bridge/tokens', {}],
  ['/indexer/elysium/tokens', { standard: 'erc20' }],
];

describe('Elysium list routes behind the pass-through limiter', () => {
  let now = Date.parse('2026-11-10T10:00:00.000Z');

  beforeEach(() => {
    // The fallback counters live in the module: move on a minute so every
    // case starts in a fresh one-second window.
    now += 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    sawUpstreamCaller.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(LIST_REQUESTS)('%s answers 429 past the pass-through burst', async (path, query) => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get(path).query(query)).status).toBe(200);
    }
    const limited = await request(app).get(path).query(query);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    // Every admitted request ran as an upstream caller: its misses are counted.
    expect(sawUpstreamCaller).toEqual([true, true, true]);
  });

  it('keeps the address routes on their own, tighter limiter only', async () => {
    const app = buildApp();
    const path = `/indexer/elysium/user/${ADDR}/balances`;
    expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get(path)).status).toBe(429);
    // The address budget did not spend the list budget of the same client.
    expect((await request(app).get('/indexer/elysium/blocks')).status).toBe(200);
    expect(sawUpstreamCaller).toEqual([true, true, true]);
  });
});
