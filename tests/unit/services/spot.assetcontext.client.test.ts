/**
 * The spot poller turns Hyperliquid `spotMetaAndAssetCtxs` into the rows served
 * by `/market/spot` (Redis `spot:markets`):
 * - one row per pair of the universe, its context matched by coin name (the
 *   contexts also list pairs the universe leaves out, so positions differ);
 * - the quote token is named (most pairs are quoted in USDC, not all);
 * - pairs without a context or a base token are left out, rows sorted by
 *   24h volume, largest first;
 * - the bridge reserve of tokens minted on their HyperEVM system address is
 *   taken out of the circulating supply, so out of the market cap.
 */
process.env.HL_CTX_STREAM_ENABLED = 'false'; // the REST-only poller; the stream has its own tests
const mockRedis = {
  set: jest.fn<Promise<unknown>, [string, string]>(),
  publish: jest.fn<Promise<unknown>, [string, string]>(),
};

const XAUT0_ID = '0xfd61ec89811ba3cf2ae12d0ed8ef1afd';
const RUBT_ID = '0x224950f99c3354ed475df173324124bd';
const XAUT0_RESERVE = 184467436800.4237670898;
/** More than RUBT's circulating supply: a reserve read before a supply change. */
const RUBT_RESERVE = 18446744073709.55078125 + 5000;
const mockReserves = {
  load: jest.fn(async () => undefined),
  reserveOf: jest.fn((id: string) => ({ [XAUT0_ID]: XAUT0_RESERVE, [RUBT_ID]: RUBT_RESERVE })[id] ?? 0),
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/spot/bridgeReserve.service', () => ({
  SpotBridgeReserveService: { getInstance: () => mockReserves },
}));

const token = (name: string, index: number, tokenId: string): Record<string, unknown> => ({
  name,
  szDecimals: 2,
  weiDecimals: 8,
  index,
  tokenId,
  isCanonical: false,
  evmContract: null,
  fullName: null,
});

const ctx = (coin: string, markPx: string, dayNtlVlm: string, circulatingSupply: string): Record<string, unknown> => ({
  coin,
  markPx,
  midPx: markPx,
  prevDayPx: '80.0',
  dayNtlVlm,
  circulatingSupply,
});

const HYPE_ID = '0x0d01dc56dcaaca66ad901c959b4011ec';
const UBTC_ID = '0x8f254b963e8468305d409b33aa137c67';

const SPOT_META = {
  tokens: [
    token('USDC', 0, '0x6d1e7cde53ba9467b783cb7c530ce054'),
    token('PURR', 1, '0xc1fb593aeffbeb02f85e0308e9956a90'),
    token('HYPE', 150, HYPE_ID),
    token('UBTC', 197, UBTC_ID),
    token('USDE', 235, '0x2e6d84f2d7ca82e6581e03523e4389f7'),
    token('USDT0', 268, '0x25faedc3f054130dbb4e4203aca63567'),
    token('USDH', 360, '0x54e00a5988577cb0b0c9ab0cb6ef7f4b'),
    token('XAUT0', 297, XAUT0_ID),
    token('RUBT', 425, RUBT_ID),
  ],
  universe: [
    { name: 'PURR/USDC', tokens: [1, 0], index: 0, isCanonical: true },
    { name: '@107', tokens: [150, 0], index: 107, isCanonical: false },
    { name: '@142', tokens: [197, 0], index: 142, isCanonical: false },
    { name: '@207', tokens: [150, 268], index: 207, isCanonical: false },
    { name: '@232', tokens: [150, 360], index: 232, isCanonical: false },
    { name: '@255', tokens: [150, 235], index: 255, isCanonical: false },
    { name: '@300', tokens: [999, 0], index: 300, isCanonical: false }, // base token unknown
    { name: '@301', tokens: [1, 998], index: 301, isCanonical: false }, // quote token unknown
    { name: '@302', tokens: [1, 0], index: 302, isCanonical: false }, // no context
    { name: '@182', tokens: [297, 0], index: 182, isCanonical: false },
    { name: '@209', tokens: [297, 268], index: 209, isCanonical: false },
    { name: '@273', tokens: [425, 268], index: 273, isCanonical: false },
  ],
};

// Listed by market index, with pairs the universe leaves out in between.
const CONTEXTS = [
  ctx('PURR/USDC', '0.12168', '3193004.93', '594769469.81'),
  ctx('@71', '1.0', '999999999.0', '1.0'),
  ctx('@107', '85.794', '101934882.87', '302165564.64'),
  ctx('@142', '82483.0', '44631926.92', '20999999.99'),
  ctx('@149', '2.0', '888888888.0', '1.0'),
  ctx('@182', '4165.5', '570711.61', '184467440737.0719909668'),
  ctx('@207', '85.827', '89206.31', '302165564.64'),
  ctx('@209', '4137.0', '82.74', '184467440737.0719909668'),
  ctx('@232', '63.129', '0.0', '302165564.64'),
  ctx('@255', '85.822', '27302.78', '302165564.64'),
  ctx('@273', '78.0', '0.0', '18446744073709.55078125'),
  ctx('@300', '5.0', '100.0', '1.0'),
  ctx('@301', '0.5', '50.0', '10.0'),
];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Row {
  name: string;
  logo: string | null;
  price: number;
  marketCap: number;
  volume: number;
  change24h: number;
  liquidity: number;
  supply: number;
  marketIndex: number;
  tokenId: string;
  quote: string;
  bridgeReserve?: number;
}

describe('HyperliquidSpotClient poll', () => {
  let rows: Row[];

  beforeAll(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.publish.mockResolvedValue(1);
    const { HyperliquidSpotClient } = require('../../../src/clients/hyperliquid/spot/spot.assetcontext.client');
    const client = HyperliquidSpotClient.getInstance();
    jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, CONTEXTS]);
    client.startPolling();
    await flush();
    const write = mockRedis.set.mock.calls.find(([key]) => key === 'spot:markets');
    if (!write) throw new Error('spot:markets was not written');
    rows = JSON.parse(write[1]) as Row[];
  });

  afterAll(() => jest.useRealTimers());

  const row = (marketIndex: number): Row | undefined => rows.find((r) => r.marketIndex === marketIndex);

  it('names the quote token of each pair', () => {
    expect(rows.map((r) => [r.marketIndex, r.quote])).toEqual(
      expect.arrayContaining([
        [0, 'USDC'],
        [107, 'USDC'],
        [142, 'USDC'],
        [207, 'USDT0'],
        [232, 'USDH'],
        [255, 'USDE'],
      ])
    );
  });

  it('reads an unknown quote token as USDC', () => {
    expect(row(301)?.quote).toBe('USDC');
  });

  it('matches each pair with the context of its coin, not of its position', () => {
    expect(row(107)).toMatchObject({ price: 85.794, volume: 101934882.87, supply: 302165564.64 });
    expect(row(232)).toMatchObject({ price: 63.129, volume: 0, supply: 302165564.64 });
    expect(row(301)).toMatchObject({ price: 0.5, volume: 50, supply: 10 });
  });

  it('serves the other fields as before', () => {
    expect(row(142)).toEqual({
      name: 'BTC',
      logo: 'https://app.hyperliquid.xyz/coins/BTC_USDC.svg',
      price: 82483,
      marketCap: 82483 * 20999999.99,
      volume: 44631926.92,
      change24h: Number((((82483 - 80) / 80) * 100).toFixed(2)),
      liquidity: 82483,
      supply: 20999999.99,
      marketIndex: 142,
      tokenId: UBTC_ID,
      quote: 'USDC',
    });
  });

  it('leaves out pairs without a base token or a context, and sorts by 24h volume', () => {
    expect(rows.map((r) => r.marketIndex)).toEqual([107, 142, 0, 182, 207, 255, 209, 301, 232, 273]);
  });

  it('takes the bridge reserve out of the supply and the market cap, on every pair of the token', () => {
    const supply = Number('184467440737.0719909668') - XAUT0_RESERVE;
    expect(supply).toBeGreaterThan(3936);
    expect(supply).toBeLessThan(3937);
    expect(row(182)).toMatchObject({ price: 4165.5, supply, marketCap: 4165.5 * supply, bridgeReserve: XAUT0_RESERVE });
    expect(row(209)).toMatchObject({ price: 4137, supply, marketCap: 4137 * supply, bridgeReserve: XAUT0_RESERVE });
  });

  it('never takes out more than the circulating supply', () => {
    expect(row(273)).toMatchObject({ supply: 0, marketCap: 0, bridgeReserve: 18446744073709.55078125 });
  });

  it('leaves rows without a reserve as they were, without a bridgeReserve field', () => {
    expect(row(0)).toMatchObject({ supply: 594769469.81, marketCap: 0.12168 * 594769469.81 });
    for (const r of rows.filter((x) => ![182, 209, 273].includes(x.marketIndex))) {
      expect(r).not.toHaveProperty('bridgeReserve');
    }
  });

  it('loads the kept reserves before writing the rows', () => {
    expect(mockReserves.load).toHaveBeenCalled();
    const marketsWrite = mockRedis.set.mock.invocationCallOrder[mockRedis.set.mock.calls.findIndex(([key]) => key === 'spot:markets')];
    expect(mockReserves.load.mock.invocationCallOrder[0]).toBeLessThan(marketsWrite);
  });
});
