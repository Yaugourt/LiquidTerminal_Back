/**
 * Bridge reserves parked on the HyperEVM system address of spot tokens
 * (0x20 + the token index). Hyperliquid counts them as circulating; the spot
 * poller subtracts what this service reads:
 * - the genesis of each listed token is read once, largest reported cap first,
 *   HYPE never; the role it gives the system address is kept in Redis for good:
 *   a reserve when the genesis credits it, watched when the genesis credits a
 *   single other address, none otherwise;
 * - the system address balance is read with the role, then every 5 minutes for
 *   a reserve and every 30 for a watched token, oldest first, before any
 *   genesis read; a watched token whose system address holds 99% of the
 *   circulating supply becomes a reserve for good;
 * - a cycle spends 60 weight at most (BRIDGE_RESERVE_MAX_WEIGHT_PER_CYCLE;
 *   these tests run at 180 to see several tokens per cycle) and stops at the
 *   first failed read; a token whose read failed waits before its next try;
 * - while Redis can't be read the stored state is read again later, nothing
 *   is rescanned and a save never replaces the stored map with a partial one.
 */
process.env.BRIDGE_RESERVE_MAX_WEIGHT_PER_CYCLE = '180';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisStore = new Map<string, string>();

const redisSet = jest.fn(async (key: string, value: string) => {
  redisStore.set(key, value);
});
/** Redis unreadable: get answers null (as for a missing key), mget null overall. */
let redisDown = false;
const redisGet = jest.fn(async (key: string) => (redisDown ? null : redisStore.get(key) ?? null));
const redisMget = jest.fn(async (keys: string[]) => (redisDown ? null : keys.map((k) => redisStore.get(k) ?? null)));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: (key: string) => redisGet(key),
    mget: (keys: string[]) => redisMget(keys),
    set: (key: string, value: string) => redisSet(key, value),
  },
}));

type ServiceModule = typeof import('../../../src/services/spot/bridgeReserve.service');
type Balance = { coin: string; token: number; total: string };

interface Fixture {
  name: string;
  index: number;
  tokenId: string;
  markPx: string;
  circulatingSupply: string;
  /** tokenDetails genesis credits; null for a token without genesis. */
  genesis?: [string, string][] | null;
  /** What the token's system address holds. */
  systemBalances?: Balance[];
}

const sys = (index: number): string => '0x20' + index.toString(16).padStart(38, '0');
const id = (i: number): string => `0x${i.toString(16).padStart(32, '0')}`;

// Live values of 2026-10-09.
const XAUT0: Fixture = {
  name: 'XAUT0',
  index: 297,
  tokenId: '0xfd61ec89811ba3cf2ae12d0ed8ef1afd',
  markPx: '4165.5',
  circulatingSupply: '184467440737.0719909668',
  genesis: [['0x2000000000000000000000000000000000000129', '184467440737.0955200195']],
  systemBalances: [{ coin: 'XAUT0', token: 297, total: '184467436800.4237670898' }],
};
const AXL: Fixture = {
  name: 'AXL',
  index: 388,
  tokenId: '0x9fb16485b70ac89fd8c45b1a130e1601',
  markPx: '0.057843',
  circulatingSupply: '184467440737.0955200195',
  genesis: [['0x2000000000000000000000000000000000000184', '184467440737.0955200195']],
  systemBalances: [
    // Same coin name, other token: not AXL's balance.
    { coin: 'AXL', token: 9999, total: '5' },
    { coin: 'AXL', token: 388, total: '184465860143.4927062988' },
  ],
};
/** Minted to its issuer, which then parked all but ~18 on the system address. */
const AAPL: Fixture = {
  name: 'AAPL',
  index: 413,
  tokenId: '0x' + 'a'.repeat(32),
  markPx: '231.5',
  circulatingSupply: '18362500000.0',
  genesis: [['0x6dc7314816000000000000000000000000000000', '18362500000.0']],
  systemBalances: [{ coin: 'AAPL', token: 413, total: '18362499981.61' }],
};
/** Minted to its issuer, which moved a tenth to the system address: watched, no reserve. */
const USDE: Fixture = {
  name: 'USDE',
  index: 235,
  tokenId: '0x2e6d84f2d7ca82e6581e03523e4389f7',
  markPx: '0.9996',
  circulatingSupply: '100000000000.0',
  genesis: [['0x59aca060ff4911d73dcf5dbd1ebbf3950424054f', '100000000000.0']],
  systemBalances: [{ coin: 'USDE', token: 235, total: '9994201019.7136707306' }],
};
const HYPE: Fixture = {
  name: 'HYPE',
  index: 150,
  tokenId: '0x0d01dc56dcaaca66ad901c959b4011ec',
  markPx: '85.794',
  circulatingSupply: '302165564.64',
};
const PURR: Fixture = {
  name: 'PURR',
  index: 1,
  tokenId: '0xc1fb593aeffbeb02f85e0308e9956a90',
  markPx: '0.12168',
  circulatingSupply: '594769469.81',
  genesis: null,
  systemBalances: [{ coin: 'PURR', token: 1, total: '92523834.15' }],
};
/** Plain tokens (two genesis holders), reported caps 999 down to 990. */
const PLAIN: Fixture[] = Array.from({ length: 10 }, (_, i) => ({
  name: `T${i + 1}`,
  index: 500 + i,
  tokenId: id(500 + i),
  markPx: '1',
  circulatingSupply: String(999 - i),
  genesis: [
    ['0x1111111111111111111111111111111111111111', String(990 - i)],
    ['0x2222222222222222222222222222222222222221', '9'],
  ],
}));

const FIXTURES = [PURR, HYPE, XAUT0, AXL, USDE, AAPL, ...PLAIN];

/**
 * The spot poller's cache. AAPL and AXL are listed twice: AAPL's first pair
 * and AXL's second have no context.
 */
const spotRawData = (fixtures: Fixture[]): string => {
  const universe = [
    { name: '@1999', tokens: [AAPL.index, 0], index: 1999 },
    ...fixtures.map((f, i) => ({ name: `@${1000 + i}`, tokens: [f.index, 0], index: 1000 + i })),
  ];
  universe.push({ name: '@2000', tokens: [AXL.index, 0], index: 2000 });
  const contexts = fixtures.map((f, i) => ({
    coin: `@${1000 + i}`,
    markPx: f.markPx,
    circulatingSupply: f.circulatingSupply,
  }));
  const tokens = [{ name: 'USDC', index: 0, tokenId: id(0) }, ...fixtures.map(({ name, index, tokenId }) => ({ name, index, tokenId }))];
  return JSON.stringify([{ tokens, universe }, contexts]);
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SpotBridgeReserveService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let now: number;
  /** Names whose genesis read fails, `NAME:balance` for balance reads. */
  let failing: Set<string>;
  /** System address → its balances, per test. */
  let systemBalances: Map<string, Balance[]>;
  let mod: ServiceModule;

  const reads = (): { type: string; key: string }[] =>
    fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body));
      return { type: body.type, key: body.tokenId ?? body.user };
    });
  const nameOf = (key: string): string =>
    FIXTURES.find((f) => f.tokenId === key || sys(f.index) === key)?.name ?? key;
  const genesisReads = (): string[] => reads().filter((r) => r.type === 'tokenDetails').map((r) => nameOf(r.key));
  const balanceReads = (): string[] => reads().filter((r) => r.type === 'spotClearinghouseState').map((r) => nameOf(r.key));
  const weight = (): number => reads().reduce((sum, r) => sum + (r.type === 'tokenDetails' ? 20 : 2), 0);
  const saved = (): Record<string, unknown> => JSON.parse(redisStore.get('spot:bridge-reserve:v1') ?? '{}');

  const fresh = (): ServiceModule => {
    jest.resetModules();
    return require('../../../src/services/spot/bridgeReserve.service');
  };
  const runCycle = (service: InstanceType<ServiceModule['SpotBridgeReserveService']>): Promise<void> =>
    (service as unknown as { runCycle(): Promise<void> }).runCycle();

  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    redisStore.clear();
    redisStore.set('spot:raw_data', spotRawData(FIXTURES));
    redisGet.mockClear();
    redisSet.mockClear();
    redisMget.mockClear();
    redisDown = false;
    failing = new Set();
    systemBalances = new Map(FIXTURES.map((f) => [sys(f.index), f.systemBalances ?? []]));
    fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === 'tokenDetails') {
        const f = FIXTURES.find((x) => x.tokenId === body.tokenId);
        if (!f || failing.has(f.name)) return json(null);
        return json({ genesis: f.genesis === null ? null : { userBalances: f.genesis ?? [] }, nonCirculatingUserBalances: [] });
      }
      if (failing.has(`${nameOf(body.user)}:balance`)) return json({ error: 'boom' }, 400);
      return json({ balances: systemBalances.get(body.user) ?? [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    mod = fresh();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('systemAddressOf', () => {
    it('is 0x20, zeros, then the token index in hex', () => {
      expect(mod.systemAddressOf(388)).toBe('0x2000000000000000000000000000000000000184');
      expect(mod.systemAddressOf(1)).toBe('0x2000000000000000000000000000000000000001');
      expect(mod.systemAddressOf(425)).toBe('0x20000000000000000000000000000000000001a9');
    });
  });

  describe('classifyGenesis', () => {
    const address = sys(425); // 0x…01a9
    const other = '0x6dc7314816000000000000000000000000000000';

    it('makes a reserve of a system address the genesis credits, any case', () => {
      expect(mod.classifyGenesis({ genesis: { userBalances: [['0x20000000000000000000000000000000000001A9', '5']] } }, address)).toBe('reserve');
      expect(mod.classifyGenesis({ genesis: { userBalances: [['0xabc', '1'], [address, '5']] } }, address)).toBe('reserve');
    });

    it('watches a token whose genesis credits a single other address', () => {
      expect(mod.classifyGenesis({ genesis: { userBalances: [[other, '5']] } }, address)).toBe('watch');
      // A zero credit doesn't count, to the system address or another.
      expect(mod.classifyGenesis({ genesis: { userBalances: [[address, '0.0'], [other, '5']] } }, address)).toBe('watch');
    });

    it('leaves the others alone', () => {
      expect(mod.classifyGenesis({ genesis: { userBalances: [[other, '5'], ['0xabc', '1']] } }, address)).toBe('none');
      expect(mod.classifyGenesis({ genesis: { userBalances: [] } }, address)).toBe('none');
      expect(mod.classifyGenesis({ genesis: {} }, address)).toBe('none');
      expect(mod.classifyGenesis({ genesis: null }, address)).toBe('none');
    });

    it('leaves alone a system address Hyperliquid already leaves out of the circulating supply', () => {
      const excluded: [string, string][] = [[address, '5']];
      expect(mod.classifyGenesis({ genesis: { userBalances: [[address, '5']] }, nonCirculatingUserBalances: excluded }, address)).toBe('none');
      expect(mod.classifyGenesis({ genesis: { userBalances: [[other, '5']] }, nonCirculatingUserBalances: excluded }, address)).toBe('none');
    });
  });

  it('reads the genesis of the largest reported caps first, HYPE never, within 180 weight', async () => {
    await runCycle(mod.SpotBridgeReserveService.getInstance());

    // Caps: XAUT0 7.7e14, AAPL 4.3e12, USDE 1e11, HYPE 2.6e10 (not read), AXL 1.1e10, PURR 7.2e7, T1… 999…
    expect(genesisReads()).toEqual(['XAUT0', 'AAPL', 'USDE', 'AXL', 'PURR', 'T1', 'T2', 'T3']);
    // Read right after the genesis, for reserves and watched tokens.
    expect(balanceReads()).toEqual(['XAUT0', 'AAPL', 'USDE', 'AXL']);
    expect(reads().slice(0, 2).map((r) => r.type)).toEqual(['tokenDetails', 'spotClearinghouseState']);
    expect(weight()).toBe(8 * 20 + 4 * 2);
  });

  it('spends 60 weight a cycle by default', async () => {
    delete process.env.BRIDGE_RESERVE_MAX_WEIGHT_PER_CYCLE;
    try {
      await runCycle(fresh().SpotBridgeReserveService.getInstance());
      // Two genesis reads and their balances; a third would pass 60.
      expect(genesisReads()).toEqual(['XAUT0', 'AAPL']);
      expect(weight()).toBe(2 * 20 + 2 * 2);
    } finally {
      process.env.BRIDGE_RESERVE_MAX_WEIGHT_PER_CYCLE = '180';
    }
  });

  it('serves the reserves: minted on the system address, or parked there by the only genesis holder', async () => {
    const service = mod.SpotBridgeReserveService.getInstance();
    expect(service.reserveOf(XAUT0.tokenId)).toBe(0);
    await runCycle(service);

    expect(service.reserveOf(XAUT0.tokenId)).toBe(184467436800.4237670898);
    expect(service.reserveOf(AXL.tokenId)).toBe(184465860143.4927062988);
    expect(service.reserveOf(AAPL.tokenId)).toBe(18362499981.61);
    // A tenth of the supply on the system address: maybe coins users moved.
    expect(service.reserveOf(USDE.tokenId)).toBe(0);
    expect(service.reserveOf(PURR.tokenId)).toBe(0);
    expect(service.reserveOf(HYPE.tokenId)).toBe(0);
    expect(service.reserveOf(id(12345))).toBe(0);
  });

  it('keeps roles and balances in Redis, and a restart serves them without reading Hyperliquid', async () => {
    await runCycle(mod.SpotBridgeReserveService.getInstance());
    expect(saved()[XAUT0.tokenId]).toEqual({ role: 'reserve', balance: 184467436800.4237670898, balanceReadAt: now });
    expect(saved()[AAPL.tokenId]).toEqual({ role: 'reserve', balance: 18362499981.61, balanceReadAt: now });
    expect(saved()[USDE.tokenId]).toEqual({ role: 'watch', balance: 9994201019.7136707306, balanceReadAt: now });
    expect(saved()[PURR.tokenId]).toEqual({ role: 'none' });
    expect(saved()[HYPE.tokenId]).toEqual({ role: 'none' });
    expect(Object.keys(saved())).toHaveLength(9);

    fetchMock.mockClear();
    const restarted = fresh().SpotBridgeReserveService.getInstance();
    await restarted.load();
    expect(restarted.reserveOf(XAUT0.tokenId)).toBe(184467436800.4237670898);
    expect(restarted.reserveOf(AAPL.tokenId)).toBe(18362499981.61);
    expect(restarted.reserveOf(USDE.tokenId)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores stored entries it cannot read', async () => {
    redisStore.set(
      'spot:bridge-reserve:v1',
      JSON.stringify({
        [XAUT0.tokenId]: { role: 'reserve', balance: 42, balanceReadAt: now },
        [AXL.tokenId]: { role: 'maybe', balance: 7, balanceReadAt: now },
        [AAPL.tokenId]: { reserve: true, balance: 7, balanceReadAt: now },
        [USDE.tokenId]: null,
        [PURR.tokenId]: { role: 'reserve', balance: -1, balanceReadAt: now },
      })
    );
    const service = fresh().SpotBridgeReserveService.getInstance();
    await service.load();

    expect(service.reserveOf(XAUT0.tokenId)).toBe(42);
    expect(service.reserveOf(AXL.tokenId)).toBe(0);
    expect(service.reserveOf(AAPL.tokenId)).toBe(0);
    // A reserve kept without a usable balance: read again first.
    expect(service.reserveOf(PURR.tokenId)).toBe(0);
    await runCycle(service);
    expect(balanceReads()[0]).toBe('PURR');
    // Entries it couldn't read are classified again.
    expect(genesisReads()).toEqual(expect.arrayContaining(['AAPL', 'USDE', 'AXL']));
    expect(genesisReads()).not.toContain('XAUT0');
  });

  it('carries on the genesis scan next minute, without reading fresh balances again', async () => {
    const service = mod.SpotBridgeReserveService.getInstance();
    await runCycle(service);
    fetchMock.mockClear();

    now += 61_000;
    await runCycle(service);
    expect(balanceReads()).toEqual([]);
    expect(genesisReads()).toEqual(['T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10']);
  });

  it('reads reserve balances again after 5 minutes, oldest first and before any genesis', async () => {
    systemBalances.set(sys(XAUT0.index), [{ coin: 'XAUT0', token: 297, total: '100' }]);
    const service = mod.SpotBridgeReserveService.getInstance();
    await runCycle(service);
    now += 60_000;
    await runCycle(service);
    fetchMock.mockClear();
    systemBalances.set(sys(XAUT0.index), [{ coin: 'XAUT0', token: 297, total: '90' }]);
    systemBalances.set(sys(AXL.index), [{ coin: 'AXL', token: 388, total: '80' }]);

    now += 5 * 60_000;
    await runCycle(service);
    // Read at the same time: listing order. USDE is watched: not before 30 minutes.
    expect(balanceReads()).toEqual(['AAPL', 'XAUT0', 'AXL']);
    expect(reads().every((r) => r.type === 'spotClearinghouseState')).toBe(true);
    expect(service.reserveOf(XAUT0.tokenId)).toBe(90);
    expect(service.reserveOf(AXL.tokenId)).toBe(80);
  });

  it('makes a watched token a reserve, for good, once its system address holds 99% of the circulating supply', async () => {
    const service = mod.SpotBridgeReserveService.getInstance();
    await runCycle(service);
    now += 60_000;
    await runCycle(service);

    // The issuer parks 99.5% of the supply.
    systemBalances.set(sys(USDE.index), [{ coin: 'USDE', token: 235, total: '99500000000' }]);
    now += 10 * 60_000;
    await runCycle(service);
    expect(service.reserveOf(USDE.tokenId)).toBe(0); // read every 30 minutes only

    now += 20 * 60_000;
    fetchMock.mockClear();
    await runCycle(service);
    expect(balanceReads()).toContain('USDE');
    expect(service.reserveOf(USDE.tokenId)).toBe(99500000000);
    expect(saved()[USDE.tokenId]).toMatchObject({ role: 'reserve', balance: 99500000000 });

    // Bridged in since: still a reserve, read every 5 minutes.
    systemBalances.set(sys(USDE.index), [{ coin: 'USDE', token: 235, total: '50000000000' }]);
    now += 5 * 60_000;
    fetchMock.mockClear();
    await runCycle(service);
    expect(balanceReads()).toContain('USDE');
    expect(service.reserveOf(USDE.tokenId)).toBe(50000000000);
  });

  it('keeps watching below 99%', async () => {
    systemBalances.set(sys(USDE.index), [{ coin: 'USDE', token: 235, total: '98900000000' }]);
    const service = mod.SpotBridgeReserveService.getInstance();
    await runCycle(service);
    expect(service.reserveOf(USDE.tokenId)).toBe(0);
    expect(saved()[USDE.tokenId]).toMatchObject({ role: 'watch' });
  });

  it('stops the cycle at a failed genesis read and retries that token 10 minutes later', async () => {
    failing.add('AAPL');
    const service = mod.SpotBridgeReserveService.getInstance();
    await runCycle(service);
    expect(genesisReads()).toEqual(['XAUT0', 'AAPL']);
    expect(redisSet).toHaveBeenCalledTimes(1); // XAUT0's role is kept

    fetchMock.mockClear();
    now += 60_000;
    await runCycle(service);
    expect(genesisReads()).not.toContain('AAPL');
    expect(genesisReads()[0]).toBe('USDE');

    failing.delete('AAPL');
    fetchMock.mockClear();
    now += 10 * 60_000;
    await runCycle(service);
    expect(genesisReads()).toContain('AAPL');
    expect(service.reserveOf(AAPL.tokenId)).toBe(18362499981.61);
  });

  it('keeps the last balance when its read fails, and tries again 5 minutes later', async () => {
    const service = mod.SpotBridgeReserveService.getInstance();
    await runCycle(service);
    failing.add('AAPL:balance');
    fetchMock.mockClear();

    now += 5 * 60_000;
    await runCycle(service);
    // AAPL comes first: the cycle ends there.
    expect(reads()).toHaveLength(1);
    expect(service.reserveOf(AAPL.tokenId)).toBe(18362499981.61);

    fetchMock.mockClear();
    now += 60_000;
    await runCycle(service);
    expect(balanceReads()).toEqual(['XAUT0', 'AXL']);

    failing.delete('AAPL:balance');
    fetchMock.mockClear();
    now += 5 * 60_000;
    await runCycle(service);
    expect(balanceReads()).toContain('AAPL');
  });

  it('reads nothing until the spot poller has cached the spot meta', async () => {
    redisStore.delete('spot:raw_data');
    await runCycle(mod.SpotBridgeReserveService.getInstance());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("reads a reserve whose system address holds none of the token as 0", async () => {
    systemBalances.set(sys(AXL.index), [{ coin: 'AXL', token: 9999, total: '5' }]);
    const service = mod.SpotBridgeReserveService.getInstance();
    await runCycle(service);
    expect(service.reserveOf(AXL.tokenId)).toBe(0);
    expect(saved()[AXL.tokenId]).toEqual({ role: 'reserve', balance: 0, balanceReadAt: now });
  });

  it('reads the stored state again once Redis is back, without rescanning meanwhile', async () => {
    await runCycle(mod.SpotBridgeReserveService.getInstance());
    const stored = redisStore.get('spot:bridge-reserve:v1');
    fetchMock.mockClear();
    redisSet.mockClear();

    // A restart while Redis is unreadable: nothing loaded, nothing read, nothing written.
    redisDown = true;
    const restarted = fresh().SpotBridgeReserveService.getInstance();
    await expect(restarted.load()).resolves.toBe(false);
    await runCycle(restarted);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect(restarted.reserveOf(XAUT0.tokenId)).toBe(0);

    redisDown = false;
    await expect(restarted.load()).resolves.toBe(true);
    expect(restarted.reserveOf(XAUT0.tokenId)).toBe(184467436800.4237670898);
    expect(redisStore.get('spot:bridge-reserve:v1')).toBe(stored);
  });

  it('merges a save with the stored map instead of replacing it', async () => {
    // Another instance (or an earlier process) classified XAUT0 and AAPL.
    redisStore.set(
      'spot:bridge-reserve:v1',
      JSON.stringify({
        [XAUT0.tokenId]: { role: 'reserve', balance: 42, balanceReadAt: now },
        [id(9999)]: { role: 'none' },
      })
    );
    const service = mod.SpotBridgeReserveService.getInstance();
    // Loaded empty (the key was written after this process read it).
    (service as unknown as { storeLoad: Promise<boolean> }).storeLoad = Promise.resolve(true);
    await runCycle(service);

    expect(saved()[id(9999)]).toEqual({ role: 'none' });
    expect(saved()[AAPL.tokenId]).toMatchObject({ role: 'reserve' });
    expect(Object.keys(saved())).toHaveLength(10);
  });

  it('postpones a save while Redis is unreadable, then saves on the next cycle', async () => {
    const service = mod.SpotBridgeReserveService.getInstance();
    await service.load();
    // Redis drops between the cycle's reads and its save.
    redisMget.mockResolvedValueOnce(null);
    await runCycle(service);
    expect(redisSet).not.toHaveBeenCalled();
    expect(service.reserveOf(XAUT0.tokenId)).toBe(184467436800.4237670898);

    // Next cycle changes nothing (its first read fails), yet saves what the skipped save held.
    failing.add('T4');
    await runCycle(service);
    expect(genesisReads().slice(-1)).toEqual(['T4']);
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(saved()[XAUT0.tokenId]).toEqual({ role: 'reserve', balance: 184467436800.4237670898, balanceReadAt: now });
  });
});
