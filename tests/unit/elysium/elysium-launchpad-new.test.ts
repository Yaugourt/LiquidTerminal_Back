import {
  BUNNY_VIRTUAL_HYPE,
  NATIVE_HYPE,
  decodeGraduation,
  decodeLaunch,
  decodeLaunchTrade,
  launchMarketKeys,
  type LaunchMarket,
} from '../../../src/services/elysium/elysium-launchpad.util';
import fixtures from './fixtures/launchpads-2026-11-02.json';

/** Real testnet logs read on 2026-11-02 (RPC + HypeDexer), keyed by tx prefix and log index. */
const fx = fixtures as Record<string, Record<string, unknown>>;
const log = (key: string) => {
  const l = fx[key];
  if (!l) throw new Error(`missing fixture ${key}`);
  return l;
};

const marketsFor = (...launches: ReturnType<typeof decodeLaunch>[]) => {
  const m = new Map<string, LaunchMarket>();
  for (const l of launches) {
    if (!l) continue;
    for (const k of launchMarketKeys(l)) m.set(k, { token: l.token, launchpad: l.launchpad, quote: l.quote });
  }
  return m;
};

describe('aka.fun', () => {
  const launch = decodeLaunch(log('0x9d1fcfff:18'));

  it('reads the launch from the hook registration (token + V4 poolId, native HYPE quote)', () => {
    expect(launch).toMatchObject({
      launchpad: 'aka.fun',
      kind: 'v4',
      token: '0x76a6e7ea69e22c95175899709c675c3281ae80ec',
      pool: '0x6d9141f98a11d1886b5509fe688ad14d087cd2a7b0ba2dcb45209a398ddaf785',
      quote: NATIVE_HYPE,
    });
  });

  it('ignores the factory event and the Initialize log (no poolId / not a launch)', () => {
    expect(decodeLaunch(log('0x9d1fcfff:20'))).toBeNull();
    expect(decodeLaunch(log('0x9d1fcfff:11'))).toBeNull();
  });

  it('decodes buys and sells on aka.fun’s own PoolManager', () => {
    const markets = marketsFor(launch);
    const buy = decodeLaunchTrade(log('0xc29110fb:3'), markets);
    const sell = decodeLaunchTrade(log('0x868d6537:2'), markets);
    expect(buy).toMatchObject({ token: launch?.token, venue: 'v4', is_buy: true });
    expect(sell).toMatchObject({ token: launch?.token, venue: 'v4', is_buy: false });
    expect(buy!.price).toBeGreaterThan(0);
    // Tokens per HYPE are in the millions at launch: the price is a tiny fraction of a HYPE.
    expect(buy!.price).toBeLessThan(1e-3);
  });
});

describe('BunnyPad', () => {
  const elycat = decodeLaunch(log('0x0f46e854:10'));

  it('reads name, symbol and creator from the launch', () => {
    expect(elycat).toMatchObject({
      launchpad: 'BunnyPad',
      kind: 'curve',
      token: '0x54cf08191d3261d47162d21ff4f2e570c0b47b0e',
      name: 'ELYSIUM CAT',
      symbol: 'ELYCAT',
      quote: NATIVE_HYPE,
      curve: null,
    });
    expect(launchMarketKeys(elycat!)).toEqual(['0x54cf08191d3261d47162d21ff4f2e570c0b47b0e']);
  });

  it('prices on the virtual + real HYPE reserve, not on the real reserve alone', () => {
    const trade = decodeLaunchTrade(log('0x94931414:1'), marketsFor(elycat));
    expect(trade).toMatchObject({ token: elycat?.token, venue: 'curve', is_buy: true });
    const data = String(log('0x94931414:1').data);
    const w = (i: number) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
    const expected = (Number(BUNNY_VIRTUAL_HYPE + w(4)) / 1e18) / (Number(w(5)) / 1e18);
    expect(trade!.price).toBeCloseTo(expected, 15);
    expect(trade!.price).toBeGreaterThan((Number(w(4)) / Number(w(5))) * 5);
  });

  it('keeps the pad’s own buyback as a trade by the pad', () => {
    const l = log('0xaf657358:13');
    const token = `0x${String(l.topic1).slice(-40)}`;
    const t = decodeLaunchTrade(l, new Map([[token, { token, launchpad: 'BunnyPad', quote: NATIVE_HYPE }]]));
    expect(t?.trader).toBe('0x3c4f47959101557eed9bc4ae8d8d986ae8d3e5b1');
  });

  it('never routes a BunnyPad trade through the CorePad branch', () => {
    const l = log('0x94931414:1');
    const asCorePad = new Map([[String(l.address), { token: '0x54cf08191d3261d47162d21ff4f2e570c0b47b0e', launchpad: 'CorePad' as const, quote: NATIVE_HYPE }]]);
    expect(decodeLaunchTrade(l, asCorePad)).toBeNull();
  });
});

describe('Kiln', () => {
  const whatlol = decodeLaunch(log('0xcfc6745d:1'));

  it('reads token, curve, creator, name and symbol', () => {
    expect(whatlol).toMatchObject({
      launchpad: 'Kiln',
      kind: 'curve',
      token: '0x98666fd374ee5acd597420151e9cdaf8845a6ed1',
      curve: '0xeada17f813e46d82984bc88496865c87d5f41a9a',
      symbol: 'WHATLOL',
      quote: NATIVE_HYPE,
    });
  });

  it('decodes a curve buy at its average price and the graduation by token', () => {
    const buy = decodeLaunchTrade(log('0xa2fff043:4'), marketsFor(whatlol));
    expect(buy).toMatchObject({ token: whatlol?.token, venue: 'curve', is_buy: true });
    expect(buy!.price).toBeGreaterThan(0);
    expect(decodeGraduation(log('0xa2fff043:10'))).toMatchObject({ token: whatlol?.token, curve: null });
  });

  it('leaves the unbranded clone factory and unknown curves alone', () => {
    expect(decodeLaunch(log('0xf4bc2bc4:3'))).toBeNull();
    expect(decodeLaunchTrade(log('0x4b64d0f0:1'), marketsFor(whatlol))).toBeNull();
  });
});
