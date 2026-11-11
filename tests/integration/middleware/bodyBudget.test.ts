/**
 * Bodies are counted per client before the global parsers read them: a flood of
 * large JSON bodies, on any path, is refused with 429 instead of being parsed
 * and walked ahead of every route limiter.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function buildApp(): express.Express {
  // Fresh module state (the budgets live in the module) for each test.
  let app!: express.Express;
  jest.isolateModules(() => {
    const { requestBodyBudget } = require('../../../src/middleware/bodyBudget.middleware');
    const { jsonBodyParser, urlencodedBodyParser } = require('../../../src/middleware/bodyParsers.middleware');
    app = express();
    app.set('trust proxy', 1);
    let parsed = 0;
    app.use(requestBodyBudget);
    app.use(jsonBodyParser);
    app.use(urlencodedBodyParser);
    app.use((req, _res, next) => {
      if (req.body !== undefined) parsed += 1;
      next();
    });
    app.post('/echo', (req, res) => {
      res.json({ size: JSON.stringify(req.body ?? null).length });
    });
    app.get('/parsed', (_req, res) => {
      res.json({ parsed });
    });
    app.use((_req, res) => {
      res.status(404).json({ error: 'not found' });
    });
  });
  return app;
}

/** A JSON body of about `bytes` bytes. */
const body = (bytes: number): string => JSON.stringify({ pad: 'x'.repeat(bytes - 10) });

describe('request body budget', () => {
  let now: jest.SpyInstance<number, []>;
  beforeEach(() => {
    now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  });
  afterEach(() => {
    now.mockRestore();
  });

  const post = (app: express.Express, path: string, payload: string, ip = '198.51.100.7') =>
    request(app).post(path).set('X-Forwarded-For', ip).set('Content-Type', 'application/json').send(payload);

  it('lets ordinary traffic through: many small bodies and one large one', async () => {
    const app = buildApp();
    for (let i = 0; i < 60; i++) {
      const res = await post(app, '/echo', JSON.stringify({ jsonrpc: '2.0', id: i, method: 'eth_chainId' }));
      expect(res.status).toBe(200);
    }
    expect((await post(app, '/echo', body(100_000))).status).toBe(200);
  });

  it('refuses a client past its second of bodies, before parsing, on a path that does not exist too', async () => {
    const app = buildApp();
    const large = body(100_000);
    // 512 kB a second: five bodies of 100 kB fit, the sixth does not.
    for (let i = 0; i < 5; i++) expect((await post(app, '/nowhere', large)).status).toBe(404);
    const before = (await request(app).get('/parsed')).body.parsed;

    const refused = await post(app, '/nowhere', large);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.body).toMatchObject({ error: 'Rate limit exceeded' });
    // Not parsed: the counter of parsed bodies did not move.
    expect((await request(app).get('/parsed')).body.parsed).toBe(before);

    // A small body still fits what is left of the second; another client is untouched.
    expect((await post(app, '/echo', '{"a":1}')).status).toBe(200);
    expect((await post(app, '/echo', large, '198.51.100.8')).status).toBe(200);

    // Next second: the budget is back.
    now.mockReturnValue(1_800_000_000_000 + 1_000);
    expect((await post(app, '/echo', large)).status).toBe(200);
  });

  it('holds a client to its minute as well', async () => {
    const app = buildApp();
    const large = body(100_000);
    // 8 MB a minute is 80 bodies of 100 kB: five a second for sixteen seconds.
    let accepted = 0;
    for (let second = 0; second < 20; second++) {
      now.mockReturnValue(1_800_000_000_000 + second * 1_000);
      for (let i = 0; i < 5; i++) {
        const res = await post(app, '/echo', large);
        if (res.status === 200) accepted += 1;
        else expect(res.status).toBe(429);
      }
    }
    expect(accepted).toBe(83);
  }, 30_000);

  it('does not count requests the parsers do not read', async () => {
    const app = buildApp();
    const blob = Buffer.alloc(300_000, 1);
    for (let i = 0; i < 6; i++) {
      // Not JSON, not a form: an upload route's own middleware reads it.
      const res = await request(app).post('/echo').set('X-Forwarded-For', '198.51.100.7').set('Content-Type', 'application/octet-stream').send(blob);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 300; i++) {
      const res = await request(app).get('/parsed').set('X-Forwarded-For', '198.51.100.7');
      expect(res.status).toBe(200);
    }
    // And the budget is still whole for a real body.
    expect((await post(app, '/echo', body(100_000))).status).toBe(200);
  }, 30_000);

  it('counts a body without a declared length at the most the parser reads', async () => {
    const app = buildApp();
    const send = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as import('net').AddressInfo;
          const req = require('http').request(
            { host: '127.0.0.1', port, path: '/echo', method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } },
            (res: import('http').IncomingMessage) => {
              res.resume();
              res.on('end', () => server.close(() => resolve(res.statusCode ?? 0)));
            }
          );
          req.on('error', reject);
          req.end('{"a":1}');
        });
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await send());
    // Each weighs 100 kB whatever it really carries: five fit in 512 kB, not six.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
