/**
 * /indexer/twaps/source and /source/deep: one shared aggregate behind marketRateLimiter only
 * (the caller controls no cache key); nothing computed and nothing kept is a
 * 503 with a code and a Retry-After. It must not be taken for a '/:twap_id'.
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

const service = { getTwapSource: jest.fn(), getTwapSourceDeep: jest.fn(), getTwap: jest.fn(), listTwaps: jest.fn() };
jest.mock('../../../src/services/indexer/indexer-twaps.service', () => ({
  IndexerTwapsService: { getInstance: () => service },
}));

import router from '../../../src/routes/indexer/twaps.routes';

function buildApp() {
  const app = express();
  app.use('/indexer/twaps', router);
  return app;
}

describe('GET /indexer/twaps/source', () => {
  beforeEach(() => {
    service.getTwapSource.mockReset();
    service.getTwapSourceDeep.mockReset();
    service.getTwap.mockReset();
    service.listTwaps.mockReset();
    marketLimiter.mockClear();
    passthroughLimiter.mockClear();
  });

  it('answers the aggregate in the usual success envelope', async () => {
    const source = { recent: [{ twapId: 1 }], running: [], deepAt: { recent: 1, running: null }, updatedAt: 1_800_000_000_000 };
    service.getTwapSource.mockResolvedValue(source);

    const res = await request(buildApp()).get('/indexer/twaps/source');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: source });
    // Not read as the TWAP with id "source".
    expect(service.getTwap).not.toHaveBeenCalled();
  });

  it('is limited by marketRateLimiter and not by the passthrough limiter', async () => {
    service.getTwapSource.mockResolvedValue({ recent: [], running: [], updatedAt: 1 });
    service.listTwaps.mockResolvedValue([]);

    await request(buildApp()).get('/indexer/twaps/source');
    expect(marketLimiter).toHaveBeenCalledTimes(1);
    expect(passthroughLimiter).not.toHaveBeenCalled();

    // Control: the passthrough list route still goes through it.
    await request(buildApp()).get('/indexer/twaps');
    expect(passthroughLimiter).toHaveBeenCalledTimes(1);
  });

  it('answers 503 INDEXER_TWAPS_SOURCE_UNAVAILABLE, with a Retry-After, while nothing can be computed or served', async () => {
    service.getTwapSource.mockRejectedValue(new Error('402 Payment Required'));

    const res = await request(buildApp()).get('/indexer/twaps/source');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
    expect(res.body).toEqual({
      success: false,
      error: 'TWAPs temporarily unavailable',
      code: 'INDEXER_TWAPS_SOURCE_UNAVAILABLE',
    });
  });
});

describe('GET /indexer/twaps/source/deep', () => {
  beforeEach(() => {
    service.getTwapSource.mockReset();
    service.getTwapSourceDeep.mockReset();
    service.getTwap.mockReset();
    marketLimiter.mockClear();
    passthroughLimiter.mockClear();
  });

  it('answers the deep rows in the usual success envelope, behind marketRateLimiter only', async () => {
    const deep = { recent: { at: 1_800_000_000_000, rows: [{ twapId: 7 }] }, running: null };
    service.getTwapSourceDeep.mockResolvedValue(deep);

    const res = await request(buildApp()).get('/indexer/twaps/source/deep');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: deep });
    expect(marketLimiter).toHaveBeenCalledTimes(1);
    expect(passthroughLimiter).not.toHaveBeenCalled();
    expect(service.getTwapSource).not.toHaveBeenCalled();
    expect(service.getTwap).not.toHaveBeenCalled();
  });

  it('answers 503 INDEXER_TWAPS_SOURCE_DEEP_UNAVAILABLE, with a Retry-After, while nothing can be served', async () => {
    service.getTwapSourceDeep.mockRejectedValue(new Error('402 Payment Required'));

    const res = await request(buildApp()).get('/indexer/twaps/source/deep');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
    expect(res.body).toEqual({
      success: false,
      error: 'TWAPs temporarily unavailable',
      code: 'INDEXER_TWAPS_SOURCE_DEEP_UNAVAILABLE',
    });
  });
});
