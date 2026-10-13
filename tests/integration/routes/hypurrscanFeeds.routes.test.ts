/**
 * GET /market/auction/perp, /explorer/deploys and /explorer/aliases relay
 * Hypurrscan's feeds from a shared cache:
 * - 200 `{ success, data }` with the feed as sent, a stable ETag and a 304 on
 *   an unchanged poll;
 * - Hypurrscan down and nothing cached is a 503 with a code and a Retry-After,
 *   never a 500;
 * - the existing /market/auction handlers are untouched by the new /perp path.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRedis = {
  store: new Map<string, string>(),
  expiries: new Map<string, number>(),
  locks: new Set<string>(),
  isHealthy: jest.fn(() => true),
  get: jest.fn(async (key: string) => {
    const expiry = mockRedis.expiries.get(key);
    if (expiry !== undefined && Date.now() >= expiry) {
      mockRedis.store.delete(key);
      mockRedis.expiries.delete(key);
    }
    return mockRedis.store.get(key) ?? null;
  }),
  set: jest.fn(async (key: string, value: string, ttl?: number) => {
    mockRedis.store.set(key, value);
    if (ttl) mockRedis.expiries.set(key, Date.now() + ttl * 1000);
    else mockRedis.expiries.delete(key);
  }),
  delete: jest.fn(async (key: string) => {
    mockRedis.locks.delete(key);
    mockRedis.store.delete(key);
    mockRedis.expiries.delete(key);
  }),
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
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// The auction router builds these at import; they are not under test.
jest.mock('../../../src/services/spot/auction/auction.service', () => ({
  AuctionPageService: {
    getInstance: () => ({
      getAllAuctions: async () => ({ usdcAuctions: [], hypeAuctions: [], totalUsdcSpent: 0, totalHypeSpent: 0 }),
    }),
  },
}));
jest.mock('../../../src/services/spot/auction/auctionTiming.service', () => ({
  SpotDeployStateApiService: { getInstance: () => ({ getAuctionTiming: async () => ({}) }) },
}));

import express from 'express';
import request from 'supertest';
import auctionRoutes from '../../../src/routes/spot/auction.routes';
import explorerRoutes from '../../../src/routes/explorer/explorer.routes';

const AUCTIONS = [
  { time: 1761409374051, deployer: '0x888', name: 'GOLD', deployGas: '500' },
  { time: 1791278192765, user: '0x8888', action: { type: 'perpDeploy' }, block: 1, hash: '0x1ed2', error: null },
];
const DEPLOYS = [
  { time: 1791878560594, user: '0x03ad', action: { type: 'spotDeploy' }, block: 1182067406, hash: '0xd976', error: null },
];
const ALIASES = { '0x0000000000000000000000000000000000000000': 'Burn Address' };

const UPSTREAM: Record<string, unknown> = { pastAuctionsPerp: AUCTIONS, deploys: DEPLOYS, globalAliases: ALIASES };
const ROUTES = [
  ['/market/auction/perp', 'pastAuctionsPerp', AUCTIONS],
  ['/explorer/deploys', 'deploys', DEPLOYS],
  ['/explorer/aliases', 'globalAliases', ALIASES],
] as const;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function buildApp() {
  const app = express();
  app.use('/market/auction', auctionRoutes);
  app.use('/explorer', explorerRoutes);
  return app;
}

describe('Hypurrscan feed routes', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.locks.clear();
    fetchMock = jest.fn(async (url: unknown) => json(UPSTREAM[String(url).split('/').pop() as string]));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it.each(ROUTES)('GET %s answers 200 with the feed as sent', async (path, _feed, body) => {
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: body });
  });

  it('serves any number of polls from one Hypurrscan fetch per feed', async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      for (const [path] of ROUTES) await request(app).get(path);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(ROUTES)('GET %s answers 304 to an unchanged poll', async (path) => {
    const app = buildApp();
    const first = await request(app).get(path);
    expect(first.headers.etag).toBeTruthy();

    const second = await request(app).get(path).set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
  });

  it.each(ROUTES)('GET %s answers 503 HYPURRSCAN_FEED_UNAVAILABLE when Hypurrscan is down and nothing is cached', async (path) => {
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 503 }));
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({
      success: false,
      error: 'Hypurrscan data temporarily unavailable',
      code: 'HYPURRSCAN_FEED_UNAVAILABLE',
    });
  });

  it.each(ROUTES)('GET %s answers 503, not an empty 200, on an answer of the wrong shape', async (path) => {
    fetchMock.mockResolvedValue(json({}));
    // {} is a valid object for aliases only when non-empty: all three refuse it.
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(503);
  });

  it('keeps the existing /market/auction handlers', async () => {
    const res = await request(buildApp()).get('/market/auction');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ usdcAuctions: [], hypeAuctions: [], totalUsdcSpent: 0, totalHypeSpent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
