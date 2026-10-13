/**
 * Spot token details come from Hyperliquid `tokenDetails`, read on demand and
 * served without the address lists (HYPE's genesis list alone is 5 MB):
 * - every scalar field is served as sent, each list is replaced by its length;
 * - concurrent readers share one read, a summary is reused for a minute then
 *   served stale while one refresh runs;
 * - only token ids of the cached spot meta are read (fail open without it),
 *   and at most 10 reads a minute go to Hyperliquid, all tokens together;
 *   refreshes of held summaries leave 4 of them to first reads, and one
 *   client starts at most 3 first reads a minute.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisGet = jest.fn();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: (...args: unknown[]) => redisGet(...args) },
}));

const HYPE = '0x0d01dc56dcaaca66ad901c959b4011ec';
const PURR = '0xc1fb593aeffbeb02f85e0308e9956a90';
/** 0x + 32 hex digits, distinct per index. */
const tokenId = (i: number): string => `0x${i.toString(16).padStart(32, '0')}`;
const EXTRA_TOKENS = Array.from({ length: 70 }, (_, i) => tokenId(i + 1));

const spotMeta = (ids: string[]): string =>
  JSON.stringify([{ tokens: ids.map((id, index) => ({ name: `T${index}`, index, tokenId: id })), universe: [] }, []]);

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
/** Lets a background refresh land (fetch → body → snapshot). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
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

  beforeEach(() => {
    jest.resetModules();
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    redisGet.mockReset();
    redisGet.mockResolvedValue(spotMeta([HYPE, PURR, ...EXTRA_TOKENS]));
    fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
      const { tokenId: id } = JSON.parse(String(init.body));
      return json(id === PURR ? rawPurr() : rawHype());
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    mod = require('../../../src/services/spot/tokenDetails.service');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('serves every scalar field as sent and the length of each list', async () => {
    const { details, lastUpdate } = await mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT);

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

  it('shares one read between concurrent readers and between id cases', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const [a, b, c] = await Promise.all([
      service.getTokenDetails(HYPE, CLIENT),
      service.getTokenDetails(HYPE, CLIENT),
      service.getTokenDetails(HYPE.toUpperCase().replace('0X', '0x'), CLIENT),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('reuses a summary for a minute, then serves it stale while one refresh runs', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const first = await service.getTokenDetails(HYPE, CLIENT);

    now += 59_000;
    expect(await service.getTokenDetails(HYPE, CLIENT)).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => json(rawHype('998878600.0')));
    now += 2_000;
    const [stale, stale2] = await Promise.all([
      service.getTokenDetails(HYPE, CLIENT),
      service.getTokenDetails(HYPE, CLIENT),
    ]);
    expect(stale).toBe(first);
    expect(stale2).toBe(first);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const refreshed = await service.getTokenDetails(HYPE, CLIENT);
    expect(refreshed.details.totalSupply).toBe('998878600.0');
    expect(refreshed.lastUpdate).toBe(now);
  });

  it('waits for a fresh read once the summary is older than 10 minutes', async () => {
    const service = mod.TokenDetailsService.getInstance();
    await service.getTokenDetails(HYPE, CLIENT);

    fetchMock.mockImplementation(async () => json(rawHype('998878500.0')));
    now += 10 * 60_000 + 1;
    const late = await service.getTokenDetails(HYPE, CLIENT);
    expect(late.details.totalSupply).toBe('998878500.0');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects ids missing from the spot meta without reading Hyperliquid', async () => {
    const service = mod.TokenDetailsService.getInstance();
    await expect(service.getTokenDetails(tokenId(999), CLIENT)).rejects.toBeInstanceOf(mod.UnknownTokenIdError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reloads the spot meta for a missing id once it is 10 s old (new listing)', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const fresh = tokenId(999);
    await expect(service.getTokenDetails(fresh, CLIENT)).rejects.toBeInstanceOf(mod.UnknownTokenIdError);
    expect(redisGet).toHaveBeenCalledTimes(1);

    redisGet.mockResolvedValue(spotMeta([HYPE, PURR, fresh]));
    now += 5_000;
    await expect(service.getTokenDetails(fresh, CLIENT)).rejects.toBeInstanceOf(mod.UnknownTokenIdError);
    expect(redisGet).toHaveBeenCalledTimes(1);

    now += 6_000;
    await expect(service.getTokenDetails(fresh, CLIENT)).resolves.toBeDefined();
    expect(redisGet).toHaveBeenCalledTimes(2);
  });

  it('fails open on the id check while Redis has no spot meta', async () => {
    redisGet.mockResolvedValue(null);
    const service = mod.TokenDetailsService.getInstance();
    await expect(service.getTokenDetails(tokenId(999), CLIENT)).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads Hyperliquid at most 10 times a minute, all tokens together', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const [early, ...rest] = EXTRA_TOKENS;
    const first = await service.getTokenDetails(early, clientNo(0));

    // Next window: 10 cold tokens spend it.
    now += 60_000;
    for (let i = 0; i < 10; i++) await service.getTokenDetails(rest[i], clientNo(i + 1));
    expect(fetchMock).toHaveBeenCalledTimes(11);

    // A cold token gets nothing until the window ends...
    await expect(service.getTokenDetails(rest[10], clientNo(20))).rejects.toBeInstanceOf(
      mod.TokenDetailsUnavailableError
    );
    // ...a stale one keeps being served, its refresh skipped.
    now += 1_000;
    expect(await service.getTokenDetails(early, clientNo(21))).toBe(first);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(11);

    now += 60_000;
    await expect(service.getTokenDetails(rest[10], clientNo(20))).resolves.toBeDefined();
    expect(requestedIds(fetchMock).slice(-1)).toEqual([rest[10]]);
  });

  it('keeps 4 reads a minute for first reads: refreshes of held summaries stop at 6', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const held = EXTRA_TOKENS.slice(0, 8);
    for (let i = 0; i < held.length; i++) {
      if (i === 5) now += 60_000;
      await service.getTokenDetails(held[i], clientNo(i));
    }
    expect(fetchMock).toHaveBeenCalledTimes(8);

    // A new window, every summary stale: six refreshes go out, two wait.
    now += 61_000;
    for (let i = 0; i < held.length; i++) await service.getTokenDetails(held[i], clientNo(i));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(14);

    // The four reads left go to tokens with nothing to show.
    const cold = EXTRA_TOKENS.slice(8, 13);
    for (let i = 0; i < 4; i++) {
      await expect(service.getTokenDetails(cold[i], clientNo(10 + i))).resolves.toBeDefined();
    }
    await expect(service.getTokenDetails(cold[4], clientNo(14))).rejects.toBeInstanceOf(
      mod.TokenDetailsUnavailableError
    );
    expect(fetchMock).toHaveBeenCalledTimes(18);
  });

  it('lets one client start at most 3 first reads a minute, and still serves it held summaries', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const [a, b, c, d] = EXTRA_TOKENS;
    const held = await service.getTokenDetails(HYPE, clientNo(1));

    for (const id of [a, b, c]) await service.getTokenDetails(id, CLIENT);
    await expect(service.getTokenDetails(d, CLIENT)).rejects.toBeInstanceOf(mod.TokenDetailsUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Held summaries cost the client nothing; another client still reads.
    expect(await service.getTokenDetails(HYPE, CLIENT)).toBe(held);
    await expect(service.getTokenDetails(d, clientNo(2))).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // Next minute, the client's share is back.
    now += 60_000;
    await expect(service.getTokenDetails(EXTRA_TOKENS[4], CLIENT)).resolves.toBeDefined();
  });

  it('serves the last summary while Hyperliquid fails, then reports it unavailable', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const first = await service.getTokenDetails(HYPE, CLIENT);

    fetchMock.mockImplementation(async () => json(null, 500));
    now += 61_000;
    expect(await service.getTokenDetails(HYPE, CLIENT)).toBe(first);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now += 10 * 60_000;
    await expect(service.getTokenDetails(HYPE, CLIENT)).rejects.toBeInstanceOf(mod.TokenDetailsUnavailableError);
  });

  it('treats a null payload as a failed read', async () => {
    fetchMock.mockImplementation(async () => json(null));
    await expect(mod.TokenDetailsService.getInstance().getTokenDetails(HYPE, CLIENT)).rejects.toBeInstanceOf(
      mod.TokenDetailsUnavailableError
    );
  });

  it('holds 64 tokens at once and drops the least recently read one', async () => {
    const service = mod.TokenDetailsService.getInstance();
    const first = await service.getTokenDetails(HYPE, clientNo(0));
    // 64 more tokens, 10 reads a minute.
    for (let i = 0; i < 64; i++) {
      if (i % 10 === 9) now += 60_000;
      await service.getTokenDetails(EXTRA_TOKENS[i], clientNo(i + 1));
    }
    expect(fetchMock).toHaveBeenCalledTimes(65);

    // HYPE was evicted: a fresh read, not the stale summary.
    now += 60_000;
    const again = await service.getTokenDetails(HYPE, clientNo(0));
    expect(again).not.toBe(first);
    expect(again.lastUpdate).toBe(now);

    // A token read recently is still held: served stale while it refreshes.
    const recent = EXTRA_TOKENS[63];
    const held = await service.getTokenDetails(recent, clientNo(0));
    expect(held.lastUpdate).toBeLessThan(now);
  });
});
