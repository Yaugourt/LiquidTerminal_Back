/**
 * Spot token details come from Hyperliquid `tokenDetails`, read on demand and
 * served without the address lists (HYPE's genesis list alone is 5 MB):
 * - every scalar field is served as sent, each list is replaced by its length;
 * - prices and supplies are laid over from the spot poller's cache (the
 *   token's first pair) while the poller's figures are newer than the
 *   summary, so the summary itself is read at most once an hour, kept in
 *   Redis for a day and served stale while one refresh runs;
 * - only token ids of the cached spot meta are read (fail open without it);
 * - at most 10 reads go to Hyperliquid in any 60 s, all tokens together, and
 *   refreshes of held summaries leave 4 of them to first reads; a cold token
 *   waits up to 5 s for a slot, one client starts at most 20 first reads a
 *   minute, and a token that gets no read answers with its live fields
 *   (`partial`) instead of an error;
 * - a warmer reads one token a minute whose summary is missing or old, and
 *   skips a token it failed to read for a few hours.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const SPOT_KEY = 'spot:raw_data';
const redisData = new Map<string, string>();
const redisGet = jest.fn(async (key: string) => redisData.get(key) ?? null);
const redisSet = jest.fn(async (key: string, value: string) => {
  redisData.set(key, value);
});
const claimed = new Set<string>();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: (key: string) => redisGet(key),
    set: (key: string, value: string) => redisSet(key, value),
    mget: async (keys: string[]) => keys.map((key) => redisData.get(key) ?? null),
    claimKeys: async (keys: string[]) =>
      keys.map((key) => {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      }),
  },
}));

const HYPE = '0x0d01dc56dcaaca66ad901c959b4011ec';
const PURR = '0xc1fb593aeffbeb02f85e0308e9956a90';
/** 0x + 32 hex digits, distinct per index. */
const tokenId = (i: number): string => `0x${i.toString(16).padStart(32, '0')}`;
const EXTRA_TOKENS = Array.from({ length: 70 }, (_, i) => tokenId(i + 1));
const ALL = [HYPE, PURR, ...EXTRA_TOKENS];

interface Ctx {
  markPx: string;
  midPx: string | null;
  prevDayPx: string;
  circulatingSupply: string;
  totalSupply: string;
}

/** Spot meta as the poller caches it; `pairs`: [base token index, quote index, context]. */
const spotMeta = (ids: string[], pairs: Array<[number, number, Ctx]> = []): string =>
  JSON.stringify([
    {
      tokens: ids.map((id, index) => ({ name: `T${index}`, index, tokenId: id, szDecimals: 2, weiDecimals: 8 })),
      universe: pairs.map(([base, quote], index) => ({ name: `@${index}`, tokens: [base, quote], index })),
    },
    pairs.map(([, , ctx], index) => ({ ...ctx, coin: `@${index}`, dayNtlVlm: '0' })),
  ]);

const rawHype = (totalSupply = '998878622.6375647783'): Record<string, unknown> => ({
  name: 'HYPE',
  maxSupply: '1000000000.0',
  totalSupply,
  circulatingSupply: '302200983.1650179029',
  szDecimals: 2,
  weiDecimals: 8,
  midPx: '87.4015',
  markPx: '87.401',
  prevDayPx: '91.664',
  genesis: {
    userBalances: [['0xaaa', '1.5'], ['0xbbb', '2'], ['0xccc', '3']],
    existingTokenBalances: [],
    blacklistUsers: [],
  },
  deployer: null,
  deployGas: '0.0',
  deployTime: '2024-11-29T06:45:52.532',
  seededUsdc: '0.0',
  nonCirculatingUserBalances: [['0xddd', '10'], ['0xeee', '20']],
  futureEmissions: '410944214.2453140616',
});

const rawPurr = (): Record<string, unknown> => ({
  name: 'PURR',
  maxSupply: '1000000000.0',
  totalSupply: '594779024.6704800129',
  circulatingSupply: '594779013.3639600277',
  szDecimals: 0,
  weiDecimals: 5,
  midPx: null,
  markPx: '0.12396',
  prevDayPx: '0.14499',
  genesis: null,
  deployer: null,
  deployGas: null,
  deployTime: null,
  seededUsdc: '0.0',
  nonCirculatingUserBalances: [],
  futureEmissions: '0.0',
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Lets a background refresh land (fetch → body → snapshot → store). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await flush();
};

const CLIENT = '203.0.113.7';
/** A distinct client per call, for tests about the global budget. */
const clientNo = (i: number): string => `198.51.100.${i}`;

const requestedIds = (fetchMock: jest.Mock): string[] =>
  fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).tokenId);

describe('TokenDetailsService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let now: number;
  let mod: typeof import('../../../src/services/spot/tokenDetails.service');

  const load = (): void => {
    jest.resetModules();
    mod = require('../../../src/services/spot/tokenDetails.service');
  };

  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    redisData.clear();
    claimed.clear();
    redisGet.mockClear();
    redisSet.mockClear();
    redisData.set(SPOT_KEY, spotMeta(ALL));
    fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
      const { tokenId: id } = JSON.parse(String(init.body));
      return json(id === PURR ? rawPurr() : rawHype());
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    load();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('serves every scalar field as sent and the length of each list', async () => {
    const { details, lastUpdate, partial } = await mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT);

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/info$/);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      type: 'tokenDetails',
      tokenId: HYPE,
    });
    expect(details).toEqual({
      name: 'HYPE',
      maxSupply: '1000000000.0',
      totalSupply: '998878622.6375647783',
      circulatingSupply: '302200983.1650179029',
      szDecimals: 2,
      weiDecimals: 8,
      midPx: '87.4015',
      markPx: '87.401',
      prevDayPx: '91.664',
      deployer: null,
      deployGas: '0.0',
      deployTime: '2024-11-29T06:45:52.532',
      seededUsdc: '0.0',
      futureEmissions: '410944214.2453140616',
      genesisUserCount: 3,
      genesisExistingTokenCount: 0,
      nonCirculatingUserCount: 2,
    });
    expect(lastUpdate).toBe(now);
    expect(partial).toBe(false);
  });

  it('counts 0 for a token without genesis and keeps its nulls', async () => {
    const { details } = await mod.TokenDetailsService.getInstance().getTokenDetails(PURR, CLIENT);
    expect(details).toMatchObject({
      midPx: null,
      deployer: null,
      deployGas: null,
      deployTime: null,
      genesisUserCount: 0,
      genesisExistingTokenCount: 0,
      nonCirculatingUserCount: 0,
    });
  });

  it('lays the live fields of the token’s first pair over the summary', async () => {
    const usdc: Ctx = { markPx: '90.5', midPx: '90.45', prevDayPx: '88.0', circulatingSupply: '303', totalSupply: '999' };
    const other: Ctx = { markPx: '1', midPx: '1', prevDayPx: '1', circulatingSupply: '1', totalSupply: '1' };
    // HYPE (index 0) trades on @0 (its first pair) and @1; PURR (index 1) has no pair.
    redisData.set(SPOT_KEY, spotMeta(ALL, [[0, 2, usdc], [0, 3, other]]));
    const service = mod.TokenDetailsService.getInstance();

    const { details } = await service.getTokenDetails(HYPE, CLIENT);
    expect(details).toMatchObject({ ...usdc, maxSupply: '1000000000.0', genesisUserCount: 3 });
    // Without a pair the summary's own figures stay.
    expect((await service.getTokenDetails(PURR, CLIENT)).details.markPx).toBe('0.12396');

    // The poller's next figures show up within 5 s, without a Hyperliquid read.
    redisData.set(SPOT_KEY, spotMeta(ALL, [[0, 2, { ...usdc, markPx: '91' }]]));
    now += 5_001;
    expect((await service.getTokenDetails(HYPE, CLIENT)).details.markPx).toBe('91');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('matches contexts to pairs by coin name, not by position', async () => {
    const usdc: Ctx = { markPx: '90.5', midPx: '90.45', prevDayPx: '88.0', circulatingSupply: '303', totalSupply: '999' };
    const other: Ctx = { markPx: '1', midPx: '1', prevDayPx: '1', circulatingSupply: '1', totalSupply: '1' };
    const [meta, contexts] = JSON.parse(spotMeta(ALL, [[0, 2, usdc], [1, 3, other]])) as [unknown, unknown[]];
    // The poller's contexts in another order than the universe.
    redisData.set(SPOT_KEY, JSON.stringify([meta, [...contexts].reverse()]));
    const { details } = await mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT);
    expect(details.markPx).toBe('90.5');
  });

  it('keeps the summary’s own prices once the poller’s figures are older than it', async () => {
    const usdc: Ctx = { markPx: '90.5', midPx: '90.45', prevDayPx: '88.0', circulatingSupply: '303', totalSupply: '999' };
    redisData.set(SPOT_KEY, spotMeta(ALL, [[0, 2, usdc]]));
    // The poller stopped 10 minutes ago.
    redisData.set('spot:raw_data:updated_at', String(now - 10 * 60_000));
    const service = mod.TokenDetailsService.getInstance();
    expect((await service.getTokenDetails(HYPE, CLIENT)).details.markPx).toBe('87.401');

    // Running again: its figures are newer than the summary.
    redisData.set('spot:raw_data:updated_at', String(now + 1_000));
    now += 5_001;
    expect((await service.getTokenDetails(HYPE, CLIENT)).details.markPx).toBe('90.5');
  });

  it('shares one read between concurrent readers and between id cases', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const [a, b, c] = await Promise.all([
      service.getTokenDetails(HYPE, CLIENT),
      service.getTokenDetails(HYPE, CLIENT),
      service.getTokenDetails(HYPE.toUpperCase().replace('0X', '0x'), CLIENT),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('reuses a summary for an hour, then serves it stale while one refresh runs', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const first = await service.getTokenDetails(HYPE, CLIENT);

    now += 59 * 60_000;
    expect(await service.getTokenDetails(HYPE, CLIENT)).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => json(rawHype('998878600.0')));
    now += 2 * 60_000;
    const [stale, stale2] = await Promise.all([
      service.getTokenDetails(HYPE, CLIENT),
      service.getTokenDetails(HYPE, CLIENT),
    ]);
    expect(stale).toEqual(first);
    expect(stale2).toEqual(first);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const refreshed = await service.getTokenDetails(HYPE, CLIENT);
    expect(refreshed.details.totalSupply).toBe('998878600.0');
    expect(refreshed.lastUpdate).toBe(now);
  });

  it('keeps summaries in Redis for a day: a restarted process serves them without reading', async () => {
    await mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT);
    await settle();
    expect(redisSet).toHaveBeenCalledWith(`spot:token-details:${HYPE}`, expect.any(String));

    load(); // a restart: nothing in memory (resetModules also clears the fetch mock's calls)
    now += 30 * 60_000;
    const again = await mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT);
    expect(again.details.genesisUserCount).toBe(3);
    expect(again.lastUpdate).toBe(now - 30 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits for a fresh read once the summary is older than a day', async () => {
    const service = mod.TokenDetailsService.getInstance();
    await service.getTokenDetails(HYPE, CLIENT);

    fetchMock.mockImplementation(async () => json(rawHype('998878500.0')));
    now += 24 * 60 * 60_000 + 1;
    const late = await service.getTokenDetails(HYPE, CLIENT);
    expect(late.details.totalSupply).toBe('998878500.0');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects ids missing from the spot meta without reading Hyperliquid', async () => {
    const service = mod.TokenDetailsService.getInstance();
    await expect(service.getTokenDetails(tokenId(999), CLIENT)).rejects.toBeInstanceOf(mod.UnknownTokenIdError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reloads the spot meta once it is 5 s old (new listing)', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const fresh = tokenId(999);
    await expect(service.getTokenDetails(fresh, CLIENT)).rejects.toBeInstanceOf(mod.UnknownTokenIdError);
    const spotReads = (): number => redisGet.mock.calls.filter(([key]) => key === SPOT_KEY).length;
    expect(spotReads()).toBe(1);

    redisData.set(SPOT_KEY, spotMeta([...ALL, fresh]));
    now += 4_000;
    await expect(service.getTokenDetails(fresh, CLIENT)).rejects.toBeInstanceOf(mod.UnknownTokenIdError);
    expect(spotReads()).toBe(1);

    now += 2_000;
    await expect(service.getTokenDetails(fresh, CLIENT)).resolves.toBeDefined();
    expect(spotReads()).toBe(2);
  });

  it('fails open on the id check while Redis has no spot meta', async () => {
    redisData.delete(SPOT_KEY);
    const service = mod.TokenDetailsService.getInstance();
    await expect(service.getTokenDetails(tokenId(999), CLIENT)).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads Hyperliquid at most 10 times in any 60 s; a cold token past it gets its live fields', async () => {
    const usdc: Ctx = { markPx: '2', midPx: null, prevDayPx: '1.5', circulatingSupply: '10', totalSupply: '12' };
    // Token index 12 = EXTRA_TOKENS[10] trades on a pair.
    redisData.set(SPOT_KEY, spotMeta(ALL, [[12, 0, usdc]]));
    const service = mod.TokenDetailsService.getInstance();
    for (let i = 0; i < 10; i++) await service.getTokenDetails(EXTRA_TOKENS[i], clientNo(i));
    expect(fetchMock).toHaveBeenCalledTimes(10);

    // The next slot frees in 60 s, past the 5 s a reader waits: a partial answer at once.
    now += 1_000;
    const partial = await service.getTokenDetails(EXTRA_TOKENS[10], clientNo(20));
    expect(partial).toEqual({
      details: {
        name: 'T12',
        maxSupply: null,
        totalSupply: '12',
        circulatingSupply: '10',
        szDecimals: 2,
        weiDecimals: 8,
        midPx: null,
        markPx: '2',
        prevDayPx: '1.5',
        deployer: null,
        deployGas: null,
        deployTime: null,
        seededUsdc: null,
        futureEmissions: null,
        genesisUserCount: null,
        genesisExistingTokenCount: null,
        nonCirculatingUserCount: null,
      },
      lastUpdate: 0,
      partial: true,
    });
    // A token without live fields has nothing to show.
    await expect(service.getTokenDetails(EXTRA_TOKENS[11], clientNo(21))).rejects.toBeInstanceOf(
      mod.TokenDetailsUnavailableError
    );
    expect(fetchMock).toHaveBeenCalledTimes(10);

    // Once the oldest read is 60 s old, a slot is free again.
    now += 59_000;
    await expect(service.getTokenDetails(EXTRA_TOKENS[10], clientNo(20))).resolves.toMatchObject({ partial: false });
    expect(requestedIds(fetchMock).slice(-1)).toEqual([EXTRA_TOKENS[10]]);
  });

  it('leaves 4 reads of the minute to first reads: refreshes of held summaries stop at 6', async () => {
    const service = mod.TokenDetailsService.getInstance();
    for (let i = 0; i < 8; i++) await service.getTokenDetails(EXTRA_TOKENS[i], clientNo(i));
    expect(fetchMock).toHaveBeenCalledTimes(8);

    // An hour later the 8 summaries are stale: their views start refreshes,
    // served stale meanwhile, and only 6 of them get a read.
    now += 61 * 60_000;
    for (let i = 0; i < 8; i++) {
      await expect(service.getTokenDetails(EXTRA_TOKENS[i], clientNo(i))).resolves.toMatchObject({ partial: false });
    }
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(8 + 6);

    // A cold token still gets a read at once.
    await expect(service.getTokenDetails(EXTRA_TOKENS[20], clientNo(30))).resolves.toMatchObject({ partial: false });
    expect(fetchMock).toHaveBeenCalledTimes(8 + 6 + 1);
    expect(requestedIds(fetchMock).slice(-1)).toEqual([EXTRA_TOKENS[20]]);
  });

  it('lets a cold token wait up to 5 s for the next read slot', async () => {
    jest.useFakeTimers({ doNotFake: ['Date', 'setImmediate', 'nextTick', 'queueMicrotask'] });
    const service = mod.TokenDetailsService.getInstance();
    for (let i = 0; i < 10; i++) await service.getTokenDetails(EXTRA_TOKENS[i], clientNo(i));

    now += 56_000;
    const waiting = service.getTokenDetails(EXTRA_TOKENS[10], clientNo(20));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(10);
    now += 4_000;
    jest.advanceTimersByTime(4_000);
    await expect(waiting).resolves.toMatchObject({ partial: false });
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('lets one client start at most 20 first reads a minute, and still serves it held summaries', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const held = await service.getTokenDetails(HYPE, clientNo(1));

    // Twenty readers of a cold token from one client: twenty first reads, one Hyperliquid read.
    await Promise.all(Array.from({ length: 20 }, () => service.getTokenDetails(EXTRA_TOKENS[0], CLIENT)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Over its share: no read (and no spot pair here: nothing to show).
    await expect(service.getTokenDetails(EXTRA_TOKENS[1], CLIENT)).rejects.toBeInstanceOf(
      mod.TokenDetailsUnavailableError
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Held summaries cost the client nothing; another client still reads.
    expect(await service.getTokenDetails(HYPE, CLIENT)).toEqual(held);
    await expect(service.getTokenDetails(EXTRA_TOKENS[1], clientNo(2))).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Next minute, the client's share is back.
    now += 60_000;
    await expect(service.getTokenDetails(EXTRA_TOKENS[2], CLIENT)).resolves.toMatchObject({ partial: false });
  });

  it('serves the last summary while Hyperliquid fails, for up to a day', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const first = await service.getTokenDetails(HYPE, CLIENT);

    fetchMock.mockImplementation(async () => json(null, 500));
    now += 61 * 60_000;
    expect(await service.getTokenDetails(HYPE, CLIENT)).toEqual(first);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now += 24 * 60 * 60_000;
    await expect(service.getTokenDetails(HYPE, CLIENT)).rejects.toBeInstanceOf(mod.TokenDetailsUnavailableError);
  });

  it('treats a null payload as a failed read', async () => {
    fetchMock.mockImplementation(async () => json(null));
    await expect(mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT)).rejects.toBeInstanceOf(
      mod.TokenDetailsUnavailableError
    );
  });

  describe('warmer', () => {
    const warm = (): Promise<void> =>
      (mod.TokenDetailsService.getInstance() as unknown as { warmOne(): Promise<void> }).warmOne();

    it('reads one token a minute: missing first, then the oldest past 6 hours', async () => {
      // Every token stored but PURR (index 1).
      for (const id of ALL) {
        if (id !== PURR) redisData.set(`spot:token-details:${id}`, JSON.stringify({ fetchedAt: now, value: {} }));
      }
      await warm();
      expect(requestedIds(fetchMock)).toEqual([PURR]);
      expect(JSON.parse(redisData.get(`spot:token-details:${PURR}`) as string)).toMatchObject({ fetchedAt: now });

      // Same minute: another instance (or tick) does nothing.
      await warm();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Nothing missing, nothing old: no read.
      now += 60_000;
      await warm();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 6 * 60 * 60_000;
      for (const id of ALL) redisData.set(`spot:token-details:${id}`, JSON.stringify({ fetchedAt: now, value: {} }));
      redisData.set(`spot:token-details:${EXTRA_TOKENS[5]}`, JSON.stringify({ fetchedAt: now - 7 * 60 * 60_000, value: {} }));
      await warm();
      expect(requestedIds(fetchMock)).toEqual([PURR, EXTRA_TOKENS[5]]);
    });

    it('skips a token it failed to read, so one failing token can not stall it', async () => {
      // HYPE (index 0) always fails; the others are missing too.
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const { tokenId: id } = JSON.parse(String(init.body));
        return json(id === HYPE ? null : rawPurr());
      });
      await expect(warm()).rejects.toThrow();
      expect(requestedIds(fetchMock)).toEqual([HYPE]);

      now += 60_000;
      await warm();
      expect(requestedIds(fetchMock)).toEqual([HYPE, PURR]);

      // A few hours later it is tried again.
      now += 3 * 60 * 60_000;
      await expect(warm()).rejects.toThrow();
      expect(requestedIds(fetchMock).slice(-1)).toEqual([HYPE]);
    });

    it('feeds the token pages: a warmed token is served without a read of its own', async () => {
      await warm();
      expect(requestedIds(fetchMock)).toEqual([HYPE]);
      const { details } = await mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT);
      expect(details.genesisUserCount).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
