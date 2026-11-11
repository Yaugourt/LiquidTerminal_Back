/**
 * POST /elysium/rpc end to end, with the real limiters and validation:
 * - every call of a request counts against the client at its weight (a batch
 *   of N plain reads weighs N, a simulation its number of calls), where the
 *   general limiter alone counted one request;
 * - the upstream answer is relayed as received, and released once sent;
 * - the proxy's own refusals answer JSON-RPC errors the tools can read.
 * Redis is reported down, so the limiters count in memory at their own burst.
 */
process.env.ELYSIUM_RPC_RATE_LIMIT_BURST = '5';
process.env.ELYSIUM_MAINNET_RPC_URL = 'https://rpc.example.test/elysium/SECRET-KEY-123';

import express from 'express';
import request from 'supertest';

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => false,
    getClient: () => {
      throw new Error('Redis is down');
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import rpcRouter from '../../../src/routes/elysium/elysium-rpc.routes';
import {
  ElysiumRpcBusyError,
  ElysiumRpcProxyService,
  ElysiumRpcResponseTooLargeError,
} from '../../../src/services/elysium/elysium-rpc-proxy.service';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/elysium/rpc', rpcRouter);
  return app;
}

const call = (id: number | string = 1) => ({ jsonrpc: '2.0', id, method: 'eth_blockNumber', params: [] });
const batch = (n: number) => Array.from({ length: n }, (_, i) => call(i));
/** An answer as the proxy returns it, with a spy on its release. */
const answer = (text: string) => {
  const chunk = Buffer.from(text, 'utf8');
  return { chunks: [chunk], bytes: chunk.byteLength, release: jest.fn() };
};

describe('POST /elysium/rpc', () => {
  let now = Date.parse('2026-11-10T10:00:00.000Z');
  let forward: jest.SpyInstance;

  beforeEach(() => {
    // The fallback counters live in the module: a fresh one-second window per case.
    now += 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    forward = jest
      .spyOn(ElysiumRpcProxyService.getInstance(), 'forward')
      .mockImplementation(async () => answer('{"jsonrpc":"2.0","id":1,"result":"0x10"}'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('relays the upstream answer as received', async () => {
    const upstream = '{"jsonrpc":"2.0", "id":1,\n "result":{"big":12345678901234567890}}';
    const relayed = answer(upstream);
    forward.mockResolvedValue(relayed);

    const res = await request(buildApp()).post('/elysium/rpc').send(call());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(upstream)));
    expect(res.text).toBe(upstream);
    // The call, what it weighs, and whose it is (the client's rate-limit key).
    expect(forward).toHaveBeenCalledWith(call(), 1, expect.stringMatching(/127\.0\.0\.1/));
    // Sent: the slot and the memory it held are given back.
    expect(relayed.release).toHaveBeenCalled();
  });

  it('counts every call of a batch against the client', async () => {
    const app = buildApp();
    // Burst of 5 calls a second: 3 + 2 fit, the next single call does not.
    expect((await request(app).post('/elysium/rpc').send(batch(3))).status).toBe(200);
    expect((await request(app).post('/elysium/rpc').send(batch(2))).status).toBe(200);
    const limited = await request(app).post('/elysium/rpc').send(call());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenNthCalledWith(1, batch(3), 3, expect.any(String));

    // Next second: single calls, one unit each.
    now += 1001;
    for (let i = 0; i < 5; i++) expect((await request(app).post('/elysium/rpc').send(call())).status).toBe(200);
    expect((await request(app).post('/elysium/rpc').send(call())).status).toBe(429);
  });

  it('counts a simulation at its number of calls, and a range of logs above a plain read', async () => {
    const app = buildApp();
    const tx = { from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), data: '0x' };
    const simulate = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [tx, tx, tx] }] }, 'latest'] };
    // Burst of 5: a simulation of 3 calls and two plain reads fit, the next read does not.
    expect((await request(app).post('/elysium/rpc').send(simulate)).status).toBe(200);
    expect(forward).toHaveBeenLastCalledWith(simulate, 3, expect.any(String));
    expect((await request(app).post('/elysium/rpc').send(batch(2))).status).toBe(200);
    expect((await request(app).post('/elysium/rpc').send(call())).status).toBe(429);

    now += 1001;
    const logs = { jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{ address: '0x' + '33'.repeat(20), fromBlock: '0x1', toBlock: 'latest' }] };
    expect((await request(app).post('/elysium/rpc').send(logs)).status).toBe(200);
    expect(forward).toHaveBeenLastCalledWith(logs, 5, expect.any(String));
    expect((await request(app).post('/elysium/rpc').send(call())).status).toBe(429);
  });

  it('lets a request heavier than a whole second through alone: it takes the second', async () => {
    const app = buildApp();
    // 6 calls against a burst of 5: refused for good if it were counted at 6.
    expect((await request(app).post('/elysium/rpc').send(batch(6))).status).toBe(200);
    expect(forward).toHaveBeenLastCalledWith(batch(6), 5, expect.any(String));
    expect((await request(app).post('/elysium/rpc').send(call())).status).toBe(429);
    // Not on top of something else in the same second.
    now += 1001;
    expect((await request(app).post('/elysium/rpc').send(call())).status).toBe(200);
    expect((await request(app).post('/elysium/rpc').send(batch(6))).status).toBe(429);
  });

  it('does not charge a request the validation refused', async () => {
    const app = buildApp();
    for (let i = 0; i < 8; i++) {
      const bad = await request(app)
        .post('/elysium/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: 'earliest', toBlock: 'latest' }] });
      expect(bad.status).toBe(400);
    }
    expect((await request(app).post('/elysium/rpc').send(batch(5))).status).toBe(200);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('answers a JSON-RPC limit error, with the call id, when the answer is too large', async () => {
    forward.mockRejectedValue(new ElysiumRpcResponseTooLargeError());

    const res = await request(buildApp()).post('/elysium/rpc').send(call('abc'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      error: { code: -32005, message: 'Response too large, narrow the request' },
    });
  });

  it('answers 429 with Retry-After when the proxy is busy', async () => {
    forward.mockRejectedValue(new ElysiumRpcBusyError(17));

    const res = await request(buildApp()).post('/elysium/rpc').send(batch(2));

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
    expect(res.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'Elysium RPC busy, retry shortly' } });
  });

  it('answers 502 without detail on an upstream failure', async () => {
    forward.mockRejectedValue(new Error('ELYSIUM_MAINNET_RPC_TRANSPORT'));

    const res = await request(buildApp()).post('/elysium/rpc').send(call());

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Elysium RPC temporarily unavailable' } });
    expect(res.text).not.toContain('SECRET-KEY-123');
  });
});
