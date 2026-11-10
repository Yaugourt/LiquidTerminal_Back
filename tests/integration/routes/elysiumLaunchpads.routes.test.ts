/**
 * GET /elysium/analytics/launchpads: the query is validated and defaulted (a
 * request without parameters, as the previous front sent, gets the first 50
 * "hot" tokens), a search goes through its own per-IP limit, and a search the
 * service has no slot for answers 429. The real limiters run with Redis
 * reported down (in-memory fallback at each limiter's own burst).
 */
process.env.ELYSIUM_SEARCH_RATE_LIMIT_BURST = '2';

import express from 'express';
import request from 'supertest';

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => false,
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    getClient: () => {
      throw new Error('Redis is down');
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/services/elysium/elysium-analytics.service', () => ({
  ElysiumAnalyticsService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/elysium/elysium-ecosystem.service', () => ({
  ElysiumEcosystemService: { getInstance: () => ({}) },
}));

import router from '../../../src/routes/elysium/elysium-analytics.routes';
import {
  ElysiumLaunchpadMarketService,
  LaunchpadSearchBusyError,
} from '../../../src/services/elysium/elysium-launchpad-market.service';

function buildApp() {
  const app = express();
  app.use('/elysium/analytics', router);
  return app;
}

const PAGE = { tokens: [], total: 0, totalCapped: false, summary: {}, top: {}, hypeUsd: null, computedAt: 'x' };

describe('GET /elysium/analytics/launchpads', () => {
  let now = Date.parse('2026-11-10T10:00:00.000Z');
  let getPage: jest.SpyInstance;

  beforeEach(() => {
    // The fallback counters live in the module: a fresh one-second window per case.
    now += 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    getPage = jest.spyOn(ElysiumLaunchpadMarketService.getInstance(), 'getPage').mockResolvedValue(PAGE as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('defaults to the first 50 hot tokens when nothing is asked', async () => {
    const res = await request(buildApp()).get('/elysium/analytics/launchpads');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: PAGE });
    expect(getPage).toHaveBeenCalledWith({ sort: 'hot', limit: 50 });
  });

  it('passes launchpad, order, search text and size through, coerced and trimmed', async () => {
    await request(buildApp()).get('/elysium/analytics/launchpads').query({ pad: 'aka.fun', sort: 'mcap', q: '  Pepe ', limit: '150' });
    expect(getPage).toHaveBeenCalledWith({ pad: 'aka.fun', sort: 'mcap', q: 'Pepe', limit: 150 });
    // An empty search is no search.
    await request(buildApp()).get('/elysium/analytics/launchpads').query({ q: '   ' });
    expect(getPage).toHaveBeenLastCalledWith({ sort: 'hot', limit: 50 });
  });

  it.each([
    ['an unknown launchpad', { pad: 'Nope' }],
    ['an unknown order', { sort: 'volume' }],
    ['a size that is not a step of 50', { limit: '75' }],
    ['a size under one step', { limit: '0' }],
    ['a size over the ceiling', { limit: '5050' }],
    ['a search text over 64 characters', { q: 'x'.repeat(65) }],
  ])('refuses %s', async (_label, query) => {
    const res = await request(buildApp()).get('/elysium/analytics/launchpads').query(query);
    expect(res.status).toBe(400);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('accepts the ceiling itself', async () => {
    expect((await request(buildApp()).get('/elysium/analytics/launchpads').query({ limit: '5000' })).status).toBe(200);
    expect(getPage).toHaveBeenCalledWith({ sort: 'hot', limit: 5000 });
  });

  it('limits searches per IP on their own, without touching plain pages', async () => {
    const app = buildApp();
    expect((await request(app).get('/elysium/analytics/launchpads').query({ q: 'a' })).status).toBe(200);
    expect((await request(app).get('/elysium/analytics/launchpads').query({ q: 'ab' })).status).toBe(200);
    const limited = await request(app).get('/elysium/analytics/launchpads').query({ q: 'abc' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/elysium/analytics/launchpads').query({ sort: 'new' })).status).toBe(200);
    }
    expect(getPage).toHaveBeenCalledTimes(7);
  });

  it('answers 429 with Retry-After when every search slot is taken', async () => {
    getPage.mockRejectedValue(new LaunchpadSearchBusyError());
    const res = await request(buildApp()).get('/elysium/analytics/launchpads').query({ q: 'pepe' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({ success: false, error: 'Too many searches, retry shortly', code: 'ELYSIUM_ANALYTICS_LAUNCHPADS_ERROR' });
  });

  it('answers 503 when the database fails (a statement over its time limit included)', async () => {
    const error = new Error('canceling statement due to statement timeout');
    error.name = 'PrismaClientKnownRequestError';
    getPage.mockRejectedValue(error);
    const res = await request(buildApp()).get('/elysium/analytics/launchpads');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'Analytics unavailable', code: 'ELYSIUM_ANALYTICS_LAUNCHPADS_ERROR' });
  });
});
