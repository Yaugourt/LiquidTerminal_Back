import { enrichTwapOrders, isActiveTwap, RawTwapOrder } from '../../../src/utils/twap-enrichment.util';

const order = (a: number, extra: Partial<RawTwapOrder> = {}): RawTwapOrder => ({
  time: 1_791_141_658_043,
  user: '0xabc',
  action: { type: 'twapOrder', twap: { a, b: true, s: '2', r: false, m: 60, t: false } },
  block: 1,
  hash: `0x${a}`,
  error: null,
  ...extra,
});

const spot = [
  { name: 'HYPE', price: 40, marketIndex: 107 },
  { name: 'USDT_USDC', price: 1, marketIndex: 166 },
];
const perp = [{ name: 'BTC', price: 100_000, index: 0 }];
const metas = [
  { universe: [{ name: 'BTC' }] },
  { universe: [{ name: 'xyz:XYZ100' }, { name: 'xyz:TSLA' }] },
  null,
  { universe: [{ name: 'km:US500' }, { name: 'km:GOLD' }] },
];

describe('enrichTwapOrders', () => {
  it('resolves spot, native perp and HIP-3 markets like the front did', () => {
    const [hype, btc, tsla, usdt] = enrichTwapOrders(
      [order(10_107), order(0), order(10_000 + 100_000 + 1), order(10_166)],
      spot,
      perp,
      metas
    );

    expect(hype).toMatchObject({ tokenSymbol: 'HYPE', tokenPrice: 40, marketIndex: 107, marketType: 'spot' });
    expect(btc).toMatchObject({ tokenSymbol: 'BTC', tokenPrice: 100_000, marketIndex: 0, marketType: 'perp' });
    expect(tsla).toMatchObject({ tokenSymbol: 'TSLA', tokenPrice: 0, marketIndex: 100_001, marketType: 'hip3' });
    expect(usdt.tokenSymbol).toBe('USDT0');
    // The raw order is passed through untouched.
    expect(hype.action).toEqual(order(10_107).action);
  });

  it('splits HIP-3 indexes as 100000 + dex × 10000 + local index, for every dex', () => {
    // Live 2026-10-13: a = 180015, 190005, 200004 came back unlabeled.
    const [xyz, km, kmLocal1] = enrichTwapOrders(
      [order(100_000 + 1 * 10_000 + 0), order(100_000 + 3 * 10_000 + 0), order(130_001)],
      spot,
      perp,
      metas
    );
    expect(xyz).toMatchObject({ tokenSymbol: 'XYZ100', marketType: 'hip3', marketIndex: 100_000 });
    expect(km).toMatchObject({ tokenSymbol: 'US500', marketType: 'hip3', marketIndex: 120_000 });
    expect(kmLocal1).toMatchObject({ tokenSymbol: 'GOLD', marketType: 'hip3' });
  });

  it('falls back to "Token N" for an unknown market', () => {
    const [unknownSpot, unknownPerp, unknownHip3] = enrichTwapOrders(
      [order(10_999), order(42), order(10_000 + 300_000 + 5)],
      spot,
      perp,
      []
    );
    expect(unknownSpot).toMatchObject({ tokenSymbol: 'Token 999', marketType: 'spot', tokenPrice: 0 });
    expect(unknownPerp).toMatchObject({ tokenSymbol: 'Token 42', marketType: 'perp' });
    expect(unknownHip3).toMatchObject({ tokenSymbol: 'Token 300005', marketType: 'hip3' });
  });

  it('drops malformed orders', () => {
    const broken = { ...order(1), action: { type: 'twapOrder' } } as unknown as RawTwapOrder;
    expect(enrichTwapOrders([broken, order(-1), order(0)], spot, perp, metas)).toHaveLength(1);
  });
});

describe('isActiveTwap', () => {
  it('is true only while the order has neither ended nor failed', () => {
    expect(isActiveTwap(order(0))).toBe(true);
    expect(isActiveTwap(order(0, { ended: 'canceled' }))).toBe(false);
    expect(isActiveTwap(order(0, { error: 'Insufficient margin' }))).toBe(false);
  });
});
