/**
 * BK-P-05 spot deploy state: polled every 5 s through HypeDexer's /info (same
 * Redis key and payload as before); while the proxy is down Hyperliquid
 * (api-ui) is read at the former 20 s pace, not at every 5 s tick.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const store = new Map<string, string>();
const publish = jest.fn(async () => undefined);
const setSpy = jest.fn();
const redisSetCalls = (): number => setSpy.mock.calls.length;
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      setSpy(key);
      store.set(key, value);
    }),
    publish: (...args: unknown[]) => publish(...(args as [])),
  },
}));

import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';
import { HypeDexerInfoClient, resetInfoProxyOutages } from '../../../src/clients/hypedexer/rest/info/info.client';
import { HyperliquidSpotDeployClient } from '../../../src/clients/hyperliquid/spot/spot.deploy.client';

const STATE = {
  states: [{ startTime: 1, endTime: 2, startGas: '10', currentGas: '9', endGas: '5', status: 'active' }],
  gasAuction: { startTimeSeconds: 1_790_000_000, durationSeconds: 111_600, startGas: '10', currentGas: '9', endGas: '5' },
};
const onHyperliquid = (url: unknown): boolean => String(url).includes('hyperliquid.xyz');
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Internals = { updateDeployState(force?: boolean): Promise<void>; UPDATE_INTERVAL: number; lastDirectRead: number };

describe('HyperliquidSpotDeployClient', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let proxyUp: boolean;
  let now: number;
  const client = HyperliquidSpotDeployClient.getInstance();
  const internals = client as unknown as Internals;

  beforeEach(() => {
    proxyUp = true;
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    store.clear();
    publish.mockClear();
    setSpy.mockClear();
    fetchMock = jest.fn(async (url: string) => {
      if (onHyperliquid(url)) return json(200, STATE);
      return proxyUp ? json(200, STATE) : json(502, null);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    internals.lastDirectRead = 0;
    (CircuitBreakerService as unknown as { instances: Map<string, unknown> }).instances.delete('hypedexer-info');
    (HypeDexerInfoClient.getInstance() as unknown as { circuitBreaker: CircuitBreakerService }).circuitBreaker =
      CircuitBreakerService.getInstance('hypedexer-info');
    resetInfoProxyOutages();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  const hlCalls = (): number => fetchMock.mock.calls.filter((c) => onHyperliquid(c[0])).length;

  it('ticks every 5 s', () => {
    expect(internals.UPDATE_INTERVAL).toBe(5000);
  });

  it('reads the state through HypeDexer and writes the same key and payload', async () => {
    await internals.updateDeployState();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hlCalls()).toBe(0);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      type: 'spotDeployState',
      user: '0x0000000000000000000000000000000000000000',
    });
    expect(JSON.parse(store.get('spot:deploy:state') ?? 'null')).toEqual(STATE);
    expect(publish).toHaveBeenCalledWith('spot:deploy:updated', expect.stringContaining('DATA_UPDATED'));
    await expect(client.getSpotDeployState()).resolves.toEqual(STATE);
  });

  it('announces the state only when it changed, not at every 5 s tick', async () => {
    await internals.updateDeployState();
    expect(publish).toHaveBeenCalledTimes(1);

    // Same state: nothing written, nothing announced.
    await internals.updateDeployState();
    await internals.updateDeployState();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(redisSetCalls()).toBe(1);

    // A new auction state is.
    const next = { ...STATE, gasAuction: { ...STATE.gasAuction, currentGas: '8' } };
    fetchMock.mockImplementation(async () => json(200, next));
    now += 5_000;
    await internals.updateDeployState();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.get('spot:deploy:state') ?? 'null')).toEqual(next);
  });

  it('falls back to api-ui when the proxy fails, then reads it at most every 20 s', async () => {
    proxyUp = false;
    await internals.updateDeployState();
    expect(hlCalls()).toBe(1);
    expect(fetchMock.mock.calls.find((c) => onHyperliquid(c[0]))?.[0]).toContain('api-ui.hyperliquid.xyz');
    expect(JSON.parse(store.get('spot:deploy:state') ?? 'null')).toEqual(STATE);

    // The next 5 s ticks keep the cached state and spend no weight.
    for (const dt of [5_000, 5_000, 5_000]) {
      now += dt;
      await internals.updateDeployState();
    }
    expect(hlCalls()).toBe(1);

    now += 5_000; // 20 s since the direct read
    await internals.updateDeployState();
    expect(hlCalls()).toBe(2);
  });

  it('forces a read on a cold cache even right after a direct read', async () => {
    proxyUp = false;
    await internals.updateDeployState();
    store.clear();
    now += 1_000;
    await expect(client.getSpotDeployState()).resolves.toEqual(STATE);
    expect(hlCalls()).toBe(2);
  });

  it('rejects when both sources fail on a forced read', async () => {
    proxyUp = false;
    fetchMock.mockImplementation(async () => json(500, null));
    await expect(client.getSpotDeployState()).rejects.toThrow();
  });
});
