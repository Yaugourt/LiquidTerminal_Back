/**
 * Ensures GET /hyperfolio/* validates query/params with validateGetRequest and
 * shapes responses/errors correctly. The Hyperfolio service is mocked so no
 * request reaches the upstream API.
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

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(),
  },
}));

/** The service answers `{ data, stale }`. */
const fresh = (data: unknown) => ({ data, stale: false });

const mockService = {
  getComposition: jest.fn().mockResolvedValue(fresh({ data: { tokens: [] } })),
  getPositions: jest.fn().mockResolvedValue(fresh({ data: { protocols: [] } })),
  getPortfolioHistory: jest.fn().mockResolvedValue(fresh({ snapshots: [], summary: {} })),
  getTransactions: jest.fn().mockResolvedValue(fresh({ transactions: [] })),
  getNfts: jest.fn().mockResolvedValue(fresh({ data: { nfts: [] } })),
  getPoints: jest.fn().mockResolvedValue(fresh({ data: [] })),
  getYield: jest.fn().mockResolvedValue(fresh({ data: [] })),
  peekPositions: jest.fn().mockResolvedValue(null),
  isRateLimited: jest.fn().mockReturnValue(false),
};

jest.mock('../../../src/services/hyperfolio/hyperfolio.service', () => ({
  HyperfolioService: { getInstance: () => mockService },
}));

jest.mock('../../../src/clients/hyperfolio/hyperfolio.client', () => ({
  HyperfolioClient: { getInstance: () => ({ openPositionsStream: jest.fn() }) },
}));

import hyperfolioRoutes from '../../../src/routes/hyperfolio/hyperfolio.routes';
import { HyperfolioRateLimitedError } from '../../../src/errors/hyperfolio.errors';

const ADDRESS = '0x32309802C8feb2306240893BD79A2E4ba5314e55';

function createApp(): express.Express {
  const app = express();
  app.use('/hyperfolio', hyperfolioRoutes);
  return app;
}

describe('GET /hyperfolio/* validation smoke', () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts a 0x address and wraps the payload in the success envelope', async () => {
    const res = await request(app).get(`/hyperfolio/wallet/${ADDRESS}/composition`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { data: { tokens: [] } } });
    expect(mockService.getComposition).toHaveBeenCalledWith(ADDRESS, expect.any(String));
  });

  it('flags the last copy served when a refresh was refused or failed', async () => {
    mockService.getComposition.mockResolvedValueOnce({ data: { data: { tokens: ['old'] } }, stale: true });
    const res = await request(app).get(`/hyperfolio/wallet/${ADDRESS}/composition`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { data: { tokens: ['old'] } }, stale: true });
  });

  it('accepts .hl names on wallet endpoints', async () => {
    const res = await request(app).get('/hyperfolio/wallet/hyperfolio.hl/points');
    expect(res.status).toBe(200);
    expect(mockService.getPoints).toHaveBeenCalledWith('hyperfolio.hl', expect.any(String));
  });

  it('rejects a malformed address with 400', async () => {
    const res = await request(app).get('/hyperfolio/wallet/0x123/composition');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation Error');
    expect(mockService.getComposition).not.toHaveBeenCalled();
  });

  it('requires a 0x address on history and bounds days', async () => {
    const named = await request(app).get('/hyperfolio/wallet/hyperfolio.hl/history');
    expect(named.status).toBe(400);
    const tooLong = await request(app).get(`/hyperfolio/wallet/${ADDRESS}/history?days=9999`);
    expect(tooLong.status).toBe(400);
    const ok = await request(app).get(`/hyperfolio/wallet/${ADDRESS}/history?days=7`);
    expect(ok.status).toBe(200);
    expect(mockService.getPortfolioHistory).toHaveBeenCalledWith(ADDRESS, 7, expect.any(String));
  });

  it('coerces transaction filters and rejects unknown types', async () => {
    const ok = await request(app).get(
      `/hyperfolio/wallet/${ADDRESS}/transactions?page=2&offset=10&type=token&search=swap&startDate=2026-01-01`
    );
    expect(ok.status).toBe(200);
    expect(mockService.getTransactions).toHaveBeenCalledWith(ADDRESS, {
      page: 2,
      offset: 10,
      type: 'token',
      search: 'swap',
      startDate: '2026-01-01',
    }, expect.any(String));
    const bad = await request(app).get(`/hyperfolio/wallet/${ADDRESS}/transactions?type=weird`);
    expect(bad.status).toBe(400);
  });

  it('normalises yield array filters to arrays and validates enums', async () => {
    const ok = await request(app).get(
      '/hyperfolio/yield?categories=lending&protocols=hyperlend&protocols=felix&sort_by=apy&min_apy=5'
    );
    expect(ok.status).toBe(200);
    expect(mockService.getYield).toHaveBeenCalledWith({
      categories: ['lending'],
      protocols: ['hyperlend', 'felix'],
      sort_by: 'apy',
      min_apy: 5,
    }, expect.any(String));
    const bad = await request(app).get('/hyperfolio/yield?categories=nope');
    expect(bad.status).toBe(400);
  });

  it('maps a Hyperfolio rate limit to 429 with Retry-After', async () => {
    mockService.getPoints.mockRejectedValueOnce(new HyperfolioRateLimitedError());
    const res = await request(app).get(`/hyperfolio/wallet/${ADDRESS}/points`);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.body.code).toBe('HYPERFOLIO_RATE_LIMITED');
  });

  it('does not expose Hyperfolio debug endpoints', async () => {
    const res = await request(app).get(`/hyperfolio/hypercore/debug/cache/${ADDRESS}`);
    expect(res.status).toBe(404);
  });
});
