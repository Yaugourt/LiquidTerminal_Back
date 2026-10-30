/**
 * REST calls a visitor can trigger share a budget and a circuit breaker, carry
 * our User-Agent, and stop leaving once the directory is loaded.
 */
const redis = {
  mget: jest.fn(async (keys: string[]) => keys.map(() => null)),
  msetEx: jest.fn(async () => undefined),
  get: jest.fn(async () => null),
  set: jest.fn(async () => undefined),
  delete: jest.fn(),
};
jest.mock('../../../src/core/redis.service', () => ({ redisService: redis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HlNamesClient, resetHlNamesGuard } from '../../../src/clients/hlnames/hlnames.client';

const A = '0x' + 'a'.repeat(40);

function upstream(status: number, body: unknown) {
  const f = jest.fn(async () => ({
    status,
    headers: { get: (h: string) => (h === 'etag' ? null : 'application/json') },
    json: async () => body,
  }));
  (global as any).fetch = f;
  return f;
}

describe('HL Names REST budget', () => {
  const client = HlNamesClient.getInstance();
  beforeEach(() => {
    resetHlNamesGuard();
    jest.clearAllMocks();
    (client.directory as any).ready = false;
  });

  it('sends our User-Agent', async () => {
    const f = upstream(200, []);
    await client.primaryNames([A]);
    const headers = (f.mock.calls[0] as any)[1].headers;
    expect(headers['User-Agent']).toMatch(/^liquidterminal-back\//);
  });

  it('stops visitor-triggered calls past the budget', async () => {
    const f = upstream(404, null);
    let blocked = 0;
    for (let i = 0; i < 70; i++) {
      await client.resolve(`n${i}.hl`).catch(() => (blocked += 1));
    }
    expect(f).toHaveBeenCalledTimes(60);
    expect(blocked).toBe(10);
  });

  it('opens the breaker after 5 upstream failures in a row', async () => {
    const f = upstream(503, null);
    for (let i = 0; i < 8; i++) await client.resolve(`m${i}.hl`).catch(() => undefined);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('answers from the directory without any upstream call once loaded', async () => {
    const f = upstream(200, []);
    const dir = client.directory as any;
    dir.ready = true;
    dir.byAddress = new Map([[A, { name: 'alice.hl', namehash: '0x' + '1'.repeat(64), expiry: Date.now() / 1000 + 3600 }]]);
    dir.byName = new Map([['alice.hl', A]]);
    await expect(client.primaryNames([A, '0x' + 'b'.repeat(40)])).resolves.toEqual({ [A]: 'alice.hl', ['0x' + 'b'.repeat(40)]: null });
    await expect(client.resolve('alice.hl')).resolves.toBe(A);
    await expect(client.profile('0x' + 'b'.repeat(40))).resolves.toEqual({ address: '0x' + 'b'.repeat(40), name: null, avatar: null, records: {} });
    expect(f).not.toHaveBeenCalled();
  });
});
