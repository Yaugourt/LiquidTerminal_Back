/**
 * Only a client's OWN Hyperfolio refusal (its per-IP budget) skips the cache's
 * failure memory. The process-wide UpstreamThrottle saturation is shared by
 * every visitor, so it keeps leaving the ":fail" marker (and the warning)
 * that makes the next visitors take the last copy instead of asking again.
 * Real cacheService over a fake Redis; only the Hyperfolio client is mocked.
 */
const mockStore = new Map<string, string>();
const mockRedis = {
  isHealthy: () => true,
  get: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  set: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  delete: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
  getClient: () => ({ set: async () => 'OK', exists: async () => 0 }),
};
jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const clientMock = { checkRateLimit: jest.fn(() => true), getComposition: jest.fn() };
jest.mock('../../../src/clients/hyperfolio/hyperfolio.client', () => ({
  HyperfolioClient: { getInstance: () => clientMock },
}));

import { HYPERFOLIO_CACHE_KEYS } from '../../../src/constants/hyperfolio.cache';
import {
  HyperfolioClientThrottledError,
  HyperfolioThrottledError,
} from '../../../src/errors/hyperfolio.errors';
import { HyperfolioService } from '../../../src/services/hyperfolio/hyperfolio.service';
import { isCallerRefusal } from '../../../src/errors/upstreamBudget.errors';

const ADDRESS = '0x32309802C8feb2306240893BD79A2E4ba5314e55';
const failMarker = (): string => `${HYPERFOLIO_CACHE_KEYS.composition(ADDRESS)}:fail`;

describe('Hyperfolio refusals and the cache failure memory', () => {
  beforeEach(() => {
    mockStore.clear();
    clientMock.checkRateLimit.mockReset().mockReturnValue(true);
    clientMock.getComposition.mockReset();
  });

  it('a per-IP refusal is a caller refusal and leaves no ":fail" marker', async () => {
    clientMock.checkRateLimit.mockReturnValue(false);

    const error = await HyperfolioService.getInstance()
      .getComposition(ADDRESS, '6.6.6.6')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HyperfolioClientThrottledError);
    expect(isCallerRefusal(error)).toBe(true);
    expect(error).toMatchObject({ statusCode: 429, code: 'HYPERFOLIO_RATE_LIMITED' });
    expect(mockStore.has(failMarker())).toBe(false);
    expect(clientMock.getComposition).not.toHaveBeenCalled();
  });

  it('the process-wide saturation is not a caller refusal and leaves the ":fail" marker', async () => {
    clientMock.getComposition.mockRejectedValue(new HyperfolioThrottledError());

    const error = await HyperfolioService.getInstance()
      .getComposition(ADDRESS, '1.1.1.1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HyperfolioThrottledError);
    expect(error).not.toBeInstanceOf(HyperfolioClientThrottledError);
    expect(isCallerRefusal(error)).toBe(false);
    expect(mockStore.has(failMarker())).toBe(true);
  });

  it('both are still HyperfolioThrottledError, with the same 429 for the front', () => {
    const own = new HyperfolioClientThrottledError();
    const shared = new HyperfolioThrottledError();
    expect(own).toBeInstanceOf(HyperfolioThrottledError);
    expect([own.statusCode, own.code, own.message]).toEqual([shared.statusCode, shared.code, shared.message]);
  });
});
