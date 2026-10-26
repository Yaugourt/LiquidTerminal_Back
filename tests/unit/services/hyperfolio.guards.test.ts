/**
 * Upstream-protection guards of the Hyperfolio proxy:
 * - the circuit breaker ignores caller-side failures (bad input, throttles);
 * - no generic retry on 429 / timeouts, one retry on the burst 403 only;
 * - a process-wide budget caps calls per second;
 * - the service never calls upstream twice for one failed miss, caches bad
 *   input, meters misses per IP and only cools down on a real upstream throttle;
 *   the cooldown refuses misses only: cached answers are still served;
 * - /yield drops the spam pools priced with fake prices and flags absurd totals.
 */
const ADDRESS = '0x32309802C8feb2306240893BD79A2E4ba5314e55';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HyperfolioClient guards', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  // Fresh module graph per test: the client, its breaker and its throttle are singletons.
  let HyperfolioClient: typeof import('../../../src/clients/hyperfolio/hyperfolio.client').HyperfolioClient;
  let errors: typeof import('../../../src/errors/hyperfolio.errors');

  beforeEach(() => {
    jest.resetModules();
    // No real Redis: the client's daily upstream budget counts in a fake one.
    jest.doMock('../../../src/core/redis.service', () => ({
      redisService: {
        multi: () => {
          const chain = {
            incr: () => chain,
            expire: () => chain,
            exec: async () => [
              [null, 1],
              [null, 1],
            ],
          };
          return chain;
        },
      },
    }));
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    HyperfolioClient = require('../../../src/clients/hyperfolio/hyperfolio.client').HyperfolioClient;
    errors = require('../../../src/errors/hyperfolio.errors');
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('does not open the circuit breaker on repeated bad input', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'Could not resolve domain' }));
    const client = HyperfolioClient.getInstance();
    for (let i = 0; i < 6; i += 1) {
      await expect(client.getPoints(`nope${i}.hype`)).rejects.toBeInstanceOf(errors.HyperfolioBadInputError);
    }
    fetchMock.mockImplementation(async () => json({ data: [] }));
    await expect(client.getPoints(ADDRESS)).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('does not retry a 429 and maps it to HyperfolioRateLimitedError', async () => {
    fetchMock.mockImplementation(async () => json({ message: 'quota' }, 429));
    const client = HyperfolioClient.getInstance();
    await expect(client.getComposition(ADDRESS)).rejects.toBeInstanceOf(errors.HyperfolioRateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an upstream 500 and hides transport details', async () => {
    fetchMock.mockImplementation(async () => json({ message: 'boom' }, 500));
    const client = HyperfolioClient.getInstance();
    const error = await client.getComposition(ADDRESS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.HyperfolioUpstreamError);
    expect((error as Error).message).not.toContain('boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries the per-second burst 403 exactly once', async () => {
    fetchMock
      .mockImplementationOnce(async () => json({ message: 'Per-second request limit exceeded' }, 403))
      .mockImplementationOnce(async () => json({ data: [] }));
    const client = HyperfolioClient.getInstance();
    await expect(client.getPoints(ADDRESS)).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps outbound calls per second across the process', async () => {
    fetchMock.mockImplementation(async () => json({ data: [] }));
    const client = HyperfolioClient.getInstance();
    const calls = Array.from({ length: 12 }, (_, i) =>
      client.getPoints(`0x${String(i).padStart(40, '0')}`)
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fetchMock).toHaveBeenCalledTimes(8);
    await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });
});

describe('HyperfolioService guards', () => {
  const clientMock = {
    checkRateLimit: jest.fn(() => true),
    getComposition: jest.fn(),
    getYield: jest.fn(),
  };
  /** The cache behind cacheService.getOrSetWithMeta, and the last copies it keeps. */
  const cache = new Map<string, unknown>();
  const lastCopies = new Map<string, unknown>();

  let HyperfolioService: typeof import('../../../src/services/hyperfolio/hyperfolio.service').HyperfolioService;
  let errs: typeof import('../../../src/errors/hyperfolio.errors');

  beforeEach(() => {
    jest.resetModules();
    clientMock.checkRateLimit.mockReset().mockReturnValue(true);
    clientMock.getComposition.mockReset();
    clientMock.getYield.mockReset();
    cache.clear();
    lastCopies.clear();
    jest.doMock('../../../src/core/redis.service', () => ({
      redisService: { get: jest.fn(), set: jest.fn(), delete: jest.fn(), getClient: jest.fn() },
    }));
    jest.doMock('../../../src/clients/hyperfolio/hyperfolio.client', () => ({
      HyperfolioClient: { getInstance: () => clientMock },
    }));
    // Same semantics as the real cacheService.getOrSetWithMeta: a hit is
    // served without fetchFn; a throwing fetchFn runs once and its error goes
    // out, unless the key has a last copy (`lastCopies`), served stale.
    jest.doMock('../../../src/core/cache.service', () => ({
      cacheService: {
        getOrSetWithMeta: async <T>(key: string, fn: () => Promise<T>): Promise<{ data: T; stale: boolean }> => {
          if (cache.has(key)) return { data: cache.get(key) as T, stale: false };
          try {
            const value = await fn();
            cache.set(key, value);
            lastCopies.set(key, value);
            return { data: value, stale: false };
          } catch (error) {
            if (lastCopies.has(key)) return { data: lastCopies.get(key) as T, stale: true };
            throw error;
          }
        },
      },
    }));
    HyperfolioService = require('../../../src/services/hyperfolio/hyperfolio.service').HyperfolioService;
    errs = require('../../../src/errors/hyperfolio.errors');
  });

  it('calls upstream once when a miss fails', async () => {
    clientMock.getComposition.mockRejectedValue(new errs.HyperfolioUpstreamError());
    const service = HyperfolioService.getInstance();
    await expect(service.getComposition(ADDRESS, '1.1.1.1')).rejects.toBeInstanceOf(errs.HyperfolioUpstreamError);
    expect(clientMock.getComposition).toHaveBeenCalledTimes(1);
  });

  it('turns an upstream bad input into a cached marker and a 400', async () => {
    clientMock.getComposition.mockRejectedValue(new errs.HyperfolioBadInputError());
    const service = HyperfolioService.getInstance();
    await expect(service.getComposition('ghost.hype', '1.1.1.1')).rejects.toBeInstanceOf(
      errs.HyperfolioBadInputError
    );
    expect(clientMock.getComposition).toHaveBeenCalledTimes(1);
  });

  it('refuses a miss once the caller spent its per-IP budget, without a global cooldown', async () => {
    clientMock.checkRateLimit.mockReturnValueOnce(false);
    clientMock.getComposition.mockResolvedValue({ data: { tokens: [] } });
    const service = HyperfolioService.getInstance();
    await expect(service.getComposition(ADDRESS, '6.6.6.6')).rejects.toBeInstanceOf(errs.HyperfolioClientThrottledError);
    expect(clientMock.getComposition).not.toHaveBeenCalled();
    expect(service.isRateLimited()).toBe(false);
    await expect(service.getComposition(ADDRESS, '1.1.1.1')).resolves.toEqual({ data: { data: { tokens: [] } }, stale: false });
  });

  it('marks its own refusal for the cache, and no upstream failure', () => {
    // The cache leaves no failure marker behind a refusal: other visitors of the key must not pay for it.
    expect((new errs.HyperfolioClientThrottledError() as { callerRefusal?: boolean }).callerRefusal).toBe(true);
    // The process-wide saturation is shared by every visitor: the cache keeps its failure memory for it.
    for (const failure of [
      new errs.HyperfolioThrottledError(),
      new errs.HyperfolioUpstreamError(),
      new errs.HyperfolioRateLimitedError(),
    ]) {
      expect((failure as { callerRefusal?: boolean }).callerRefusal).toBeUndefined();
    }
  });

  it('serves the last copy, flagged stale, when a refresh is refused or fails', async () => {
    const service = HyperfolioService.getInstance();
    clientMock.getComposition.mockResolvedValueOnce({ data: { tokens: ['old'] } });
    await service.getComposition(ADDRESS, '1.1.1.1');
    cache.clear(); // the TTL ran out

    // Over the caller's budget: the last copy, not a 429.
    clientMock.checkRateLimit.mockReturnValueOnce(false);
    await expect(service.getComposition(ADDRESS, '6.6.6.6')).resolves.toEqual({
      data: { data: { tokens: ['old'] } },
      stale: true,
    });
    // Upstream down: same.
    clientMock.getComposition.mockRejectedValueOnce(new errs.HyperfolioUpstreamError());
    await expect(service.getComposition(ADDRESS, '1.1.1.1')).resolves.toMatchObject({ stale: true });
    expect(clientMock.getComposition).toHaveBeenCalledTimes(2);
  });

  it('opens the shared cooldown on a real upstream throttle', async () => {
    clientMock.getComposition.mockRejectedValue(new errs.HyperfolioRateLimitedError());
    const service = HyperfolioService.getInstance();
    await expect(service.getComposition(ADDRESS, '1.1.1.1')).rejects.toBeInstanceOf(errs.HyperfolioRateLimitedError);
    expect(service.isRateLimited()).toBe(true);
    await expect(service.getComposition(ADDRESS, '2.2.2.2')).rejects.toBeInstanceOf(errs.HyperfolioRateLimitedError);
    expect(clientMock.getComposition).toHaveBeenCalledTimes(1);
  });

  it('keeps serving cached answers during the cooldown, and refuses misses only', async () => {
    const OTHER = '0x0000000000000000000000000000000000000001';
    const service = HyperfolioService.getInstance();
    clientMock.getComposition.mockResolvedValueOnce({ data: { tokens: ['cached'] } });
    await service.getComposition(ADDRESS, '1.1.1.1');

    clientMock.getComposition.mockRejectedValueOnce(new errs.HyperfolioRateLimitedError());
    await expect(service.getComposition(OTHER, '1.1.1.1')).rejects.toBeInstanceOf(errs.HyperfolioRateLimitedError);
    expect(service.isRateLimited()).toBe(true);

    await expect(service.getComposition(ADDRESS, '2.2.2.2')).resolves.toEqual({
      data: { data: { tokens: ['cached'] } },
      stale: false,
    });
    await expect(service.getComposition(OTHER, '2.2.2.2')).rejects.toBeInstanceOf(errs.HyperfolioRateLimitedError);
    expect(clientMock.getComposition).toHaveBeenCalledTimes(2);
  });

  it('closes the cooldown 10 s after the upstream throttle, even under steady misses', async () => {
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const service = HyperfolioService.getInstance();
      clientMock.getComposition.mockRejectedValueOnce(new errs.HyperfolioRateLimitedError());
      await expect(service.getComposition(ADDRESS, '1.1.1.1')).rejects.toBeInstanceOf(
        errs.HyperfolioRateLimitedError
      );

      // A miss refused by the cooldown 9 s later must not re-arm it.
      now += 9_000;
      const other = '0x0000000000000000000000000000000000000002';
      await expect(service.getComposition(other, '2.2.2.2')).rejects.toBeInstanceOf(
        errs.HyperfolioRateLimitedError
      );
      expect(clientMock.getComposition).toHaveBeenCalledTimes(1);

      now += 2_000;
      expect(service.isRateLimited()).toBe(false);
      clientMock.getComposition.mockResolvedValueOnce({ data: { tokens: [] } });
      await expect(service.getComposition(other, '2.2.2.2')).resolves.toEqual({ data: { data: { tokens: [] } }, stale: false });
      expect(clientMock.getComposition).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('drops /yield rows priced past $20B of TVL and flags totals past $50B', async () => {
    const row = (id: string, tvlUsd?: number) => ({ id, pool: { address: id, name: id, tvlUsd } });
    clientMock.getYield.mockResolvedValue({
      data: [row('real', 1_900_000_000), row('lending'), row('spam', 4.2e13), row('edge', 20_000_000_000)],
      pagination: { total: 4, page: 1, page_size: 25, total_pages: 1, next: null, prev: null },
      metadata: {
        filters: { categories: [], protocols: [] },
        totals: { total_value_usd: 4.2e13, total_apy: 12, opportunity_count: 4 },
      },
    });
    const service = HyperfolioService.getInstance();

    const { data: res } = await service.getYield({ page: 1, page_size: 25 }, '1.1.1.1');
    expect(res.data.map((r) => r.id)).toEqual(['real', 'lending', 'edge']);
    expect(res.metadata.totals).toEqual({ total_value_usd: 4.2e13, total_apy: 12, opportunity_count: 4 });
    expect(res.metadata.totals_untrusted).toBe(true);

    // The cleaned answer is what gets cached.
    await service.getYield({ page: 1, page_size: 25 }, '2.2.2.2');
    expect(clientMock.getYield).toHaveBeenCalledTimes(1);
    expect([...cache.values()][0]).toBe(res);
  });

  it('leaves sane /yield totals unflagged', async () => {
    clientMock.getYield.mockResolvedValue({
      data: [{ id: 'a', pool: { address: 'a', name: 'a', tvlUsd: 5e8 } }],
      pagination: { total: 1, page: 1, page_size: 25, total_pages: 1, next: null, prev: null },
      metadata: {
        filters: { categories: [], protocols: [] },
        totals: { total_value_usd: 50_000_000_000, total_apy: 8, opportunity_count: 1 },
      },
    });
    const { data: res } = await HyperfolioService.getInstance().getYield({}, '1.1.1.1');
    expect(res.data).toHaveLength(1);
    expect(res.metadata.totals_untrusted).toBeUndefined();
  });
});
