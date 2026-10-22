/**
 * /indexer/candles: every distinct (coin, interval, start, end) is a paid
 * upstream read, so the route sits behind the pass-through limiter and only
 * accepts the coins and end times the charts send.
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

const client = { getCandles: jest.fn() };
jest.mock('../../../src/clients/hypedexer/rest/candles/candles.client', () => ({
  CANDLE_INTERVALS: ['5s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d'],
  HypeDexerCandlesClient: { getInstance: () => client },
}));

import router from '../../../src/routes/indexer/candles.routes';

function buildApp() {
  const app = express();
  app.use('/indexer/candles', router);
  return app;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HYPE_LISTING_MS = Date.UTC(2024, 10, 29);

describe('GET /indexer/candles', () => {
  beforeEach(() => {
    client.getCandles.mockReset();
    client.getCandles.mockResolvedValue([]);
    marketLimiter.mockClear();
    passthroughLimiter.mockClear();
  });

  it('is behind the pass-through limiter', async () => {
    const now = Date.now();
    await request(buildApp()).get('/indexer/candles').query({ coin: 'BTC', interval: '5s', startTime: now - HOUR });
    expect(marketLimiter).toHaveBeenCalledTimes(1);
    expect(passthroughLimiter).toHaveBeenCalledTimes(1);
  });

  it.each(['@107', 'PURR/USDC', 'BTC', 'kPEPE', 'xyz:AAPL', 'flx:SILVER', 'km:US500', '1000PEPE'])(
    'serves the coin %s the app sends',
    async (coin) => {
      const now = Date.now();
      const res = await request(buildApp())
        .get('/indexer/candles')
        .query({ coin, interval: '30s', startTime: now - 1000 * 30_000, endTime: now });
      expect(res.status).toBe(200);
      expect(client.getCandles).toHaveBeenCalledWith(coin, '30s', expect.any(Number), expect.any(Number));
    }
  );

  it('serves the chart windows as sent: a day-old end, a listing-long daily window, no end', async () => {
    const now = Date.now();
    const windows = [
      { interval: '5s', startTime: now - 5000 * 5000, endTime: now - 6 * HOUR },
      { interval: '1d', startTime: HYPE_LISTING_MS, endTime: now },
      { interval: '1d', startTime: now - 90 * DAY },
      { interval: '30s', startTime: now - 1000 * 30_000, endTime: now - (DAY - HOUR) },
    ];
    for (const w of windows) {
      const res = await request(buildApp()).get('/indexer/candles').query({ coin: '@107', ...w });
      expect(res.status).toBe(200);
    }
    expect(client.getCandles).toHaveBeenCalledTimes(windows.length);
  });

  it.each([
    ['a long free-form coin', 'A'.repeat(60)],
    ['a coin with a path', '../../etc'],
    ['a spot index far out of range', '@99999999'],
    ['an empty coin', ''],
    ['a coin with a colon only', ':'],
    ['a coin with two colons', 'a:b:c'],
  ])('rejects %s with 400, without an upstream read', async (_name, coin) => {
    const res = await request(buildApp())
      .get('/indexer/candles')
      .query({ coin, interval: '5s', startTime: Date.now() - HOUR });
    expect(res.status).toBe(400);
    expect(client.getCandles).not.toHaveBeenCalled();
  });

  it('rejects an end time more than a day in the past', async () => {
    const now = Date.now();
    const res = await request(buildApp())
      .get('/indexer/candles')
      .query({ coin: 'BTC', interval: '1d', startTime: now - 400 * DAY, endTime: now - 2 * DAY });
    expect(res.status).toBe(400);
    expect(client.getCandles).not.toHaveBeenCalled();
  });

  it('rejects start or end times before 2023', async () => {
    const now = Date.now();
    const old = await request(buildApp()).get('/indexer/candles').query({ coin: 'BTC', interval: '1d', startTime: 1000 });
    expect(old.status).toBe(400);
    const oldEnd = await request(buildApp())
      .get('/indexer/candles')
      .query({ coin: 'BTC', interval: '1d', startTime: now - DAY, endTime: 1000 });
    expect(oldEnd.status).toBe(400);
    expect(client.getCandles).not.toHaveBeenCalled();
  });
});
