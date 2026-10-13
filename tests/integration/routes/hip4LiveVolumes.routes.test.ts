/**
 * /indexer/hip4/live-volumes: one shared aggregate behind marketRateLimiter
 * only (the caller controls no cache key, so the per-IP passthrough budget is
 * not spent on it); nothing computed and nothing kept is a 503 with a code.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

const marketLimiter = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
const passthroughLimiter = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (req: Request, res: Response, next: NextFunction) => marketLimiter(req, res, next),
  passthroughRateLimiter: (req: Request, res: Response, next: NextFunction) => passthroughLimiter(req, res, next),
}));

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const service = { getLiveVolumes: jest.fn(), getAnalytics: jest.fn() };
jest.mock('../../../src/services/indexer/indexer-hip4.service', () => ({
  IndexerHip4Service: { getInstance: () => service },
}));

import router from '../../../src/routes/indexer/hip4.routes';

function buildApp() {
  const app = express();
  app.use('/indexer/hip4', router);
  return app;
}

describe('GET /indexer/hip4/live-volumes', () => {
  beforeEach(() => {
    service.getLiveVolumes.mockReset();
    service.getAnalytics.mockReset();
    marketLimiter.mockClear();
    passthroughLimiter.mockClear();
  });

  it('answers the aggregate in the usual success envelope', async () => {
    const live = { volumes: { 60: 15.5, 61: 2 }, partial: false, updatedAt: 1_800_000_000_000 };
    service.getLiveVolumes.mockResolvedValue(live);

    const res = await request(buildApp()).get('/indexer/hip4/live-volumes');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: live });
  });

  it('is limited by marketRateLimiter and not by the passthrough limiter', async () => {
    service.getLiveVolumes.mockResolvedValue({ volumes: {}, partial: false, updatedAt: 1 });
    service.getAnalytics.mockResolvedValue([]);

    await request(buildApp()).get('/indexer/hip4/live-volumes');
    expect(marketLimiter).toHaveBeenCalledTimes(1);
    expect(passthroughLimiter).not.toHaveBeenCalled();

    // Control: the passthrough routes still pass through it.
    await request(buildApp()).get('/indexer/hip4/analytics');
    expect(passthroughLimiter).toHaveBeenCalledTimes(1);
  });

  it('answers 503 INDEXER_HIP4_LIVE_VOLUMES_UNAVAILABLE, with a Retry-After, while nothing can be computed or served', async () => {
    service.getLiveVolumes.mockRejectedValue(new Error('402 Payment Required'));

    const res = await request(buildApp()).get('/indexer/hip4/live-volumes');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
    expect(res.body).toEqual({
      success: false,
      error: 'HIP-4 volumes temporarily unavailable',
      code: 'INDEXER_HIP4_LIVE_VOLUMES_UNAVAILABLE',
    });
  });
});
