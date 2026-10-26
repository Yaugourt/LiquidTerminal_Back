/**
 * /names/mintpass makes api.hlnames.xyz sign with our partner key, and
 * /names/forget drops our cached name of any address: both are POSTs anyone
 * can script, so each has a tight per-IP limiter on top of the general one.
 * A real mint asks for 1-2 passes and sends one forget, a wallet confirmation
 * apart. Real limiters, Redis mocked as fixed-window counters, HL Names mocked.
 */
import express from 'express';
import request from 'supertest';

const counters = new Map<string, number>();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => true,
    getClient: () => {
      const ops: (() => [Error | null, unknown])[] = [];
      const pipeline = {
        incr: (key: string) => {
          ops.push(() => {
            const next = (counters.get(key) ?? 0) + 1;
            counters.set(key, next);
            return [null, next];
          });
          return pipeline;
        },
        expire: () => {
          ops.push(() => [null, 1]);
          return pipeline;
        },
        exec: async () => ops.map((op) => op()),
      };
      return { pipeline: () => pipeline };
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const hlNames = {
  mintPass: jest.fn(),
  forget: jest.fn(),
  primaryNames: jest.fn(),
  resolve: jest.fn(),
  profile: jest.fn(),
};
jest.mock('../../../src/clients/hlnames/hlnames.client', () => ({
  HL_NAME_RE: /^[a-z0-9-]+\.hl$/,
  HlNamesClient: { getInstance: () => hlNames },
}));

import router from '../../../src/routes/names/names.routes';

const ADDR = '0x' + 'cd'.repeat(20);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/names', router);
  return app;
}

const mint = (app: express.Express, label = 'alice') => request(app).post(`/names/mintpass/${label}`).send({ token: 'native' });
const forget = (app: express.Express) => request(app).post(`/names/forget/${ADDR}`).send({});

describe('name mint pass and cache drop limits', () => {
  let now = Date.parse('2026-10-26T10:00:00.000Z');

  beforeEach(() => {
    counters.clear();
    // A minute boundary, so the 60 s windows start clean.
    now = Math.ceil((now + 1) / 60_000) * 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    hlNames.mintPass.mockReset().mockResolvedValue({ signature: '0x1' });
    hlNames.forget.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses a third mint pass in one second with 429 and Retry-After, without calling the provider', async () => {
    const app = buildApp();
    expect((await mint(app)).status).toBe(200);
    expect((await mint(app)).status).toBe(200);
    const limited = await mint(app);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(hlNames.mintPass).toHaveBeenCalledTimes(2);
    // The next second is a fresh window.
    now += 1000;
    expect((await mint(app)).status).toBe(200);
  });

  it('allows 20 mint passes a minute per IP, then refuses until the minute rolls over', async () => {
    const app = buildApp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await mint(app)).status);
      now += 1000;
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(hlNames.mintPass).toHaveBeenCalledTimes(20);
  });

  it('fits a USDC mint (2 passes, then 1 cache drop) for several people behind one IP', async () => {
    const app = buildApp();
    for (let person = 0; person < 5; person++) {
      expect((await mint(app, `name${person}`)).status).toBe(200);
      now += 1000;
      expect((await mint(app, `name${person}`)).status).toBe(200);
      now += 1000;
      expect((await forget(app)).status).toBe(200);
      now += 1000;
    }
  });

  it('refuses a third cache drop in one second and the 11th in a minute', async () => {
    const app = buildApp();
    expect((await forget(app)).status).toBe(200);
    expect((await forget(app)).status).toBe(200);
    const limited = await forget(app);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(hlNames.forget).toHaveBeenCalledTimes(2);

    counters.clear();
    now = Math.ceil((now + 1) / 60_000) * 60_000;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await forget(app)).status);
      now += 1000;
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('keeps the two budgets apart, and leaves the read routes alone', async () => {
    const app = buildApp();
    await mint(app);
    await mint(app);
    expect((await mint(app)).status).toBe(429);
    expect((await forget(app)).status).toBe(200);
    hlNames.profile.mockResolvedValue({ address: ADDR, name: null });
    for (let i = 0; i < 6; i++) {
      expect((await request(app).get(`/names/profile/${ADDR}`)).status).toBe(200);
    }
  });
});
