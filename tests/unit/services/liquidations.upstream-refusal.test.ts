/**
 * A client refused by its own HypeDexer budget (UpstreamBudgetExceededError)
 * reaches the route as that refusal, not wrapped into LiquidationsError(500):
 * the route answers 429 + Retry-After only for the unwrapped error. A real
 * upstream failure is still wrapped.
 */
const mockStore = new Map<string, string>();
const mockClient = {
  getLiquidations: jest.fn(),
  getRecentLiquidations: jest.fn(),
  getAnalyticsStats: jest.fn(),
};

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/repositories', () => ({ historicalLiquidationRepository: {} }));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => true,
    get: jest.fn(async (key: string) => mockStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockStore.set(key, value);
    }),
  },
}));
jest.mock('../../../src/clients/hypedexer/rest/liquidations/liquidations.client', () => ({
  HLIndexerLiquidationsClient: { getInstance: () => mockClient },
}));
jest.mock('../../../src/services/liquidations/sse-manager.service', () => ({
  SSEManagerService: { getInstance: () => ({ setDataProvider: () => undefined }) },
}));

import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';

describe('LiquidationsService and a client over its upstream budget', () => {
  let service: import('../../../src/services/liquidations/liquidations.service').LiquidationsService;

  beforeEach(() => {
    jest.resetModules();
    mockStore.clear();
    Object.values(mockClient).forEach((fn) => fn.mockReset());
    service = require('../../../src/services/liquidations/liquidations.service').LiquidationsService.getInstance();
  });

  const calls: Array<[string, keyof typeof mockClient, () => Promise<unknown>]> = [
    ['getLiquidations', 'getLiquidations', () => service.getLiquidations({ coin: 'BTC' })],
    ['getRecentLiquidations', 'getRecentLiquidations', () => service.getRecentLiquidations({ coin: 'BTC' })],
    ['getAnalyticsStats', 'getAnalyticsStats', () => service.getAnalyticsStats(1, 'BTC')],
  ];

  it.each(calls)('%s passes the refusal through unchanged and caches nothing', async (_name, clientCall, run) => {
    const refusal = new UpstreamBudgetExceededError(42);
    mockClient[clientCall].mockRejectedValue(refusal);

    const error = await run().catch((e: unknown) => e);

    expect(error).toBe(refusal);
    expect(error).not.toMatchObject({ name: 'LiquidationsError' });
    expect(mockStore.size).toBe(0);
  });

  it.each(calls)('%s still wraps a real upstream failure', async (_name, clientCall, run) => {
    mockClient[clientCall].mockRejectedValue(new Error('upstream exploded'));

    const error = await run().catch((e: unknown) => e);

    // (modules are reset per test, so the class is matched by name)
    expect(error).toMatchObject({ name: 'LiquidationsError', statusCode: 500, message: 'upstream exploded' });
  });
});
