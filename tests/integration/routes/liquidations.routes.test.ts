/**
 * /liquidations routes that reach HypeDexer (list, recent, analytics): behind
 * the pass-through limiter, with every free-form parameter bounded and the
 * time filters normalised so a fresh value is not a fresh paid read. The
 * SSE per-IP cap counts an IPv6 /64 as one client.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';

const marketLimiter = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
const passthroughLimiter = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
const addressQueryLimiter = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (req: Request, res: Response, next: NextFunction) => marketLimiter(req, res, next),
  passthroughRateLimiter: (req: Request, res: Response, next: NextFunction) => passthroughLimiter(req, res, next),
  indexerAddressQueryRateLimiter: (req: Request, res: Response, next: NextFunction) =>
    addressQueryLimiter(req, res, next),
}));

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { isHealthy: () => true, get: jest.fn(async () => null), set: jest.fn(async () => undefined) },
}));

const service = {
  getLiquidations: jest.fn(),
  getRecentLiquidations: jest.fn(),
  getAnalyticsStats: jest.fn(),
  getAllData: jest.fn(),
  getAllStats: jest.fn(),
  getChartData: jest.fn(),
  getTopLiquidations: jest.fn(),
};
const sse = { addClient: jest.fn(), removeClient: jest.fn(), getStats: jest.fn() };
jest.mock('../../../src/services/liquidations/liquidations.service', () => ({
  LiquidationsService: { getInstance: () => service },
}));
jest.mock('../../../src/services/liquidations/sse-manager.service', () => ({
  SSEManagerService: { getInstance: () => sse },
}));
jest.mock('../../../src/services/liquidations/liquidations.ingestion.service', () => ({
  LiquidationsIngestionService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/liquidations/liquidations.backfill.service', () => ({
  LiquidationsBackfillService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/liquidations/liquidations.ws.service', () => ({
  LiquidationsWebSocketService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/websocket', () => ({ InternalWebSocketServer: { getInstance: () => ({}) } }));
jest.mock('../../../src/services/liquidations/liquidations.historical-stats.service', () => ({
  HistoricalStatsService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/liquidations/liquidations.historical-chart.service', () => ({
  HistoricalChartService: { getInstance: () => ({}) },
}));

import router from '../../../src/routes/liquidations/liquidations.routes';

function buildApp() {
  const app = express();
  app.use('/liquidations', router);
  return app;
}

const ok = { success: true, data: [], total_count: 0, execution_time_ms: 0, next_cursor: null, has_more: false };

describe('/liquidations routes that reach HypeDexer', () => {
  beforeEach(() => {
    Object.values(service).forEach((fn) => fn.mockReset());
    service.getLiquidations.mockResolvedValue(ok);
    service.getRecentLiquidations.mockResolvedValue(ok);
    service.getAnalyticsStats.mockResolvedValue({ success: true });
    marketLimiter.mockClear();
    passthroughLimiter.mockClear();
    addressQueryLimiter.mockClear();
  });

  it.each(['/liquidations', '/liquidations/recent', '/liquidations/analytics/stats'])(
    '%s is behind the pass-through limiter',
    async (path) => {
      await request(buildApp()).get(path);
      expect(passthroughLimiter).toHaveBeenCalledTimes(1);
    }
  );

  // The limiter itself counts only requests that name a wallet (user=), see
  // indexerAddressQueryRateLimiter; here: the two routes that take one have it.
  it.each(['/liquidations', '/liquidations/recent'])('%s is behind the per-address limiter', async (path) => {
    await request(buildApp()).get(path).query({ user: '0x' + 'a'.repeat(40) });
    expect(addressQueryLimiter).toHaveBeenCalledTimes(1);
  });

  it('keeps the analytics route off the per-address limiter', async () => {
    await request(buildApp()).get('/liquidations/analytics/stats');
    expect(addressQueryLimiter).not.toHaveBeenCalled();
  });

  it('leaves the DB-backed routes on the market limiter only', async () => {
    service.getAllData.mockResolvedValue({ success: true });
    await request(buildApp()).get('/liquidations/data');
    expect(marketLimiter).toHaveBeenCalledTimes(1);
    expect(passthroughLimiter).not.toHaveBeenCalled();
  });

  it('serves the front calls unchanged', async () => {
    const calls: Array<[string, Record<string, string | number>]> = [
      ['/liquidations/recent', { limit: 1000, hours: 2 }],
      ['/liquidations/recent', { limit: 60 }],
      ['/liquidations/recent', { limit: 50, hours: 2, order: 'DESC', coin: 'xyz:AAPL', amount_dollars: 12345.5 }],
      ['/liquidations', { user: '0x' + 'a'.repeat(40), limit: 100, order: 'DESC' }],
    ];
    for (const [path, query] of calls) {
      const res = await request(buildApp()).get(path).query(query);
      expect(res.status).toBe(200);
    }
    expect(service.getRecentLiquidations).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 1000, hours: 2 }));
    expect(service.getRecentLiquidations).toHaveBeenNthCalledWith(3, expect.objectContaining({ coin: 'xyz:AAPL', amount_dollars: 12345.5 }));
    expect(service.getLiquidations).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, order: 'DESC' }));
  });

  it.each([
    ['a long coin', { coin: 'A'.repeat(200) }],
    ['a coin with a slash path', { coin: '../x' }],
    ['a free-form cursor', { cursor: 'x'.repeat(500) }],
    ['a non-keyset cursor', { cursor: 'abc def' }],
    ['a non-ISO start_time', { start_time: 'yesterday' }],
    ['a pre-2023 start_time', { start_time: '2001-01-01T00:00:00Z' }],
    ['a far-future end_time', { end_time: '2999-01-01T00:00:00Z' }],
    ['a limit above 1000', { limit: 5000 }],
    ['a huge amount_dollars', { amount_dollars: 1e30 }],
  ])('rejects %s with 400 and no upstream read', async (_name, query) => {
    for (const path of ['/liquidations', '/liquidations/recent']) {
      const res = await request(buildApp()).get(path).query(query);
      expect(res.status).toBe(400);
    }
    expect(service.getLiquidations).not.toHaveBeenCalled();
    expect(service.getRecentLiquidations).not.toHaveBeenCalled();
  });

  it('accepts a keyset cursor as HypeDexer hands it out', async () => {
    const res = await request(buildApp()).get('/liquidations').query({ cursor: '1761100000000:123456789' });
    expect(res.status).toBe(200);
    expect(service.getLiquidations).toHaveBeenCalledWith(expect.objectContaining({ cursor: '1761100000000:123456789' }));
  });

  it('floors start_time and end_time to the minute, so a millisecond is not a new read', async () => {
    const t0 = Date.UTC(2025, 5, 1, 12, 30, 0, 0);
    const a = new Date(t0 + 11_111).toISOString();
    const b = new Date(t0 + 49_999).toISOString();
    await request(buildApp()).get('/liquidations').query({ start_time: a, end_time: b });
    await request(buildApp()).get('/liquidations').query({ start_time: b, end_time: a });
    const [first, second] = service.getLiquidations.mock.calls.map(([params]) => params);
    expect(first.start_time).toBe(new Date(t0).toISOString());
    expect(first.end_time).toBe(new Date(t0).toISOString());
    expect(second).toEqual(first);
  });

  it('drops start_time and end_time next to hours, which the upstream ignores them for', async () => {
    await request(buildApp())
      .get('/liquidations/recent')
      .query({ hours: 2, start_time: '2025-06-01T00:00:00Z', end_time: '2025-06-02T00:00:00Z' });
    const params = service.getRecentLiquidations.mock.calls[0][0];
    expect(params.hours).toBe(2);
    expect(params.start_time).toBeUndefined();
    expect(params.end_time).toBeUndefined();
  });

  it('ignores hours above a week on the list route', async () => {
    await request(buildApp()).get('/liquidations').query({ hours: 100000 });
    expect(service.getLiquidations.mock.calls[0][0].hours).toBeUndefined();
  });

  it('rejects a malformed analytics coin and passes a valid one', async () => {
    const bad = await request(buildApp()).get('/liquidations/analytics/stats').query({ coin: 'x'.repeat(100) });
    expect(bad.status).toBe(400);
    const good = await request(buildApp()).get('/liquidations/analytics/stats').query({ coin: 'btc', days: 7 });
    expect(good.status).toBe(200);
    expect(service.getAnalyticsStats).toHaveBeenCalledWith(7, 'btc');
  });
});

describe('GET /liquidations/stream', () => {
  beforeEach(() => {
    sse.addClient.mockReset();
    sse.addClient.mockResolvedValue(null);
  });

  function ipSeenBySse(): string {
    return sse.addClient.mock.calls[0][1];
  }

  it('counts a whole IPv6 /64 as one client', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use('/liquidations', router);
    await request(app).get('/liquidations/stream').set('X-Forwarded-For', '2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    await request(app).get('/liquidations/stream').set('X-Forwarded-For', '2001:db8:1:2:1111:2222:3333:4444');
    expect(sse.addClient.mock.calls[0][1]).toBe('2001:db8:1:2::/64');
    expect(sse.addClient.mock.calls[1][1]).toBe('2001:db8:1:2::/64');
  });

  it('keeps an IPv4 address as is', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use('/liquidations', router);
    await request(app).get('/liquidations/stream').set('X-Forwarded-For', '203.0.113.7');
    expect(ipSeenBySse()).toBe('203.0.113.7');
  });

  it('releases the client when the connection drops while it is being added', async () => {
    let finishAdding!: (id: string) => void;
    sse.addClient.mockReset();
    sse.removeClient.mockReset();
    sse.addClient.mockReturnValue(new Promise<string>((resolve) => { finishAdding = resolve; }));

    const server = buildApp().listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const req = http.get({ port, path: '/liquidations/stream' });
      req.on('error', () => undefined);
      await waitFor(() => sse.addClient.mock.calls.length === 1);
      req.destroy();
      await new Promise((r) => setTimeout(r, 100)); // the server sees the close

      finishAdding('client-1');
      await waitFor(() => sse.removeClient.mock.calls.length > 0);
      expect(sse.removeClient).toHaveBeenCalledWith('client-1');
    } finally {
      server.close();
    }
  });
});

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
}
