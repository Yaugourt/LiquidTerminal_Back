/**
 * /indexer/hip4/resolutions: one shared entry behind marketRateLimiter only
 * (no params, so no caller-picked cache key); nothing computed and nothing
 * kept is a 503 with a code.
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

const service = { getResolutions: jest.fn() };
jest.mock('../../../src/services/indexer/indexer-hip4.service', () => ({
  IndexerHip4Service: { getInstance: () => service },
}));

import router from '../../../src/routes/indexer/hip4.routes';

function buildApp() {
  const app = express();
  app.use('/indexer/hip4', router);
  return app;
}

describe('GET /indexer/hip4/resolutions', () => {
  beforeEach(() => {
    service.getResolutions.mockReset();
    marketLimiter.mockClear();
    passthroughLimiter.mockClear();
  });

  it('answers the entry in the usual success envelope, behind marketRateLimiter only', async () => {
    const entry = {
      coins: { '#1100': { final_price: 0.99991, final_trade_at: '2026-05-31T02:20:03.688Z', won: true, won_by: 'final_price' } },
      computed_at: '2026-10-22T10:00:00.000Z',
    };
    service.getResolutions.mockResolvedValue(entry);

    const res = await request(buildApp()).get('/indexer/hip4/resolutions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: entry });
    expect(marketLimiter).toHaveBeenCalledTimes(1);
    expect(passthroughLimiter).not.toHaveBeenCalled();
  });

  it('answers 503 INDEXER_HIP4_RESOLUTIONS_UNAVAILABLE, with a Retry-After, while nothing can be computed or served', async () => {
    service.getResolutions.mockRejectedValue(new Error('outcomeMeta listed no outcome'));

    const res = await request(buildApp()).get('/indexer/hip4/resolutions');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
    expect(res.body).toEqual({
      success: false,
      error: 'HIP-4 resolutions temporarily unavailable',
      code: 'INDEXER_HIP4_RESOLUTIONS_UNAVAILABLE',
    });
  });
});
