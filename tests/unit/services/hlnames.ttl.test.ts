/**
 * Any visitor can ask about any address, so "no name" answers must not sit in
 * Redis for 6 h: names keep 6 h, negative entries get 5 minutes.
 */
const redis = {
  mget: jest.fn(),
  msetEx: jest.fn(async () => undefined),
  get: jest.fn(),
  set: jest.fn(async () => undefined),
  delete: jest.fn(),
};
jest.mock('../../../src/core/redis.service', () => ({ redisService: redis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HlNamesClient } from '../../../src/clients/hlnames/hlnames.client';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const SIX_H = 6 * 3600;

function upstream(status: number, body: unknown) {
  (global as any).fetch = jest.fn(async () => ({
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  }));
}

describe('HlNamesClient cache TTLs', () => {
  const client = HlNamesClient.getInstance();
  beforeEach(() => {
    Object.values(redis).forEach((f) => f.mockClear());
    redis.mget.mockImplementation(async (keys: string[]) => keys.map(() => null));
  });

  it('keeps names 6 h and caches "no name" for 300 s', async () => {
    upstream(200, [{ address: A, primaryName: 'alice.hl' }]); // B left out = no name
    await expect(client.primaryNames([A, B])).resolves.toEqual({ [A]: 'alice.hl', [B]: null });

    expect(redis.msetEx).toHaveBeenCalledWith([[`hlnames:primary:${A}`, 'alice.hl']], SIX_H);
    expect(redis.msetEx).toHaveBeenCalledWith([[`hlnames:primary:${B}`, '']], 300);
  });

  it('never writes a 6 h entry for addresses without a name', async () => {
    upstream(200, []);
    await client.primaryNames([A, B]);
    const sixHourWrites = redis.msetEx.mock.calls.filter((c) => (c as unknown[])[1] === SIX_H && (c as unknown as [unknown[]])[0].length > 0);
    expect(sixHourWrites).toHaveLength(0);
  });

  it('caches an unregistered .hl name (404/422) for 300 s, a resolved one for 6 h', async () => {
    redis.get.mockResolvedValue(null);
    upstream(404, null);
    await expect(client.resolve('nobody.hl')).resolves.toBeNull();
    expect(redis.set).toHaveBeenLastCalledWith('hlnames:fwd:nobody.hl', '', 300);

    upstream(200, { address: A.toUpperCase().replace('0X', '0x') });
    await expect(client.resolve('alice.hl')).resolves.toBe(A);
    expect(redis.set).toHaveBeenLastCalledWith('hlnames:fwd:alice.hl', A, SIX_H);
  });

  it('caches a profile without a name for 300 s', async () => {
    redis.get.mockResolvedValue(null);
    upstream(200, { primaryName: null, avatar: null });
    await client.profile(A);
    expect(redis.set).toHaveBeenLastCalledWith(`hlnames:profile:${A}`, expect.any(String), 300);
  });
});
