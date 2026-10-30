/**
 * BK-R-10 allPerpMetas (TWAP enrichment): read through HypeDexer's /info
 * (byte-identical to Hyperliquid's answer, no Hyperliquid weight), from
 * Hyperliquid when the proxy fails.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/redis.service', () => ({ redisService: { get: jest.fn(async () => null), set: jest.fn() } }));

import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';
import { HypeDexerInfoClient, resetInfoProxyOutages } from '../../../src/clients/hypedexer/rest/info/info.client';
import { TwapService } from '../../../src/services/twap/twap.service';

const METAS = [{ universe: [{ name: 'BTC' }, { name: 'ETH' }] }, { universe: [{ name: 'xyz:GOLD' }] }, null];
const onHyperliquid = (url: unknown): boolean => String(url).includes('hyperliquid.xyz');
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TwapService allPerpMetas', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let proxyUp: boolean;
  const metasOf = (): Promise<unknown> =>
    (TwapService.getInstance() as unknown as { metasClient: { getAllPerpMetas(): Promise<unknown> } }).metasClient.getAllPerpMetas();

  beforeEach(() => {
    proxyUp = true;
    fetchMock = jest.fn(async (url: string) => {
      if (onHyperliquid(url)) return json(200, METAS);
      return proxyUp ? json(200, METAS) : json(502, null);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    (CircuitBreakerService as unknown as { instances: Map<string, unknown> }).instances.delete('hypedexer-info');
    (HypeDexerInfoClient.getInstance() as unknown as { circuitBreaker: CircuitBreakerService }).circuitBreaker =
      CircuitBreakerService.getInstance('hypedexer-info');
    resetInfoProxyOutages();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('reads the metas through HypeDexer, not Hyperliquid', async () => {
    await expect(metasOf()).resolves.toEqual(METAS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onHyperliquid(fetchMock.mock.calls[0][0])).toBe(false);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ type: 'allPerpMetas' });
  });

  it('reads Hyperliquid, same result, when the proxy fails', async () => {
    proxyUp = false;
    await expect(metasOf()).resolves.toEqual(METAS);
    expect(fetchMock.mock.calls.filter((c) => onHyperliquid(c[0]))).toHaveLength(1);
  });
});
