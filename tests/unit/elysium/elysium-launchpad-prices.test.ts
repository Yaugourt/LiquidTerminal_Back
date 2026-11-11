/**
 * Launch trade prices (2026-11-11): the quote's own decimals are used everywhere (a pool price
 * and a Signal curve trade were read as if every quote had 18), and a pool trade whose event
 * gives no price is stored at what the trade paid, never at 0.
 */
import {
  LAUNCHPAD_TOPICS,
  NEURIIO_USDC,
  SIGNAL_WHYPE,
  decodeLaunchTrade,
  priceFromSqrt,
  type LaunchMarket,
} from '../../../src/services/elysium/elysium-launchpad.util';

const Q96 = 2n ** 96n;
const ADDR = (c: string): string => `0x${c.repeat(40)}`;
const topicOf = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;
const uint = (v: bigint): string => v.toString(16).padStart(64, '0');
const int = (v: bigint): string => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');
const E18 = 10n ** 18n;

const log = (over: Record<string, unknown>) => ({
  block_time: '2026-11-11T10:00:00',
  block_number: 123,
  log_index: 4,
  tx_hash: `0x${'1'.repeat(64)}`,
  topic1: topicOf(ADDR('a')),
  topic2: topicOf(ADDR('b')),
  topic3: '',
  ...over,
});

describe('a pool price', () => {
  it('is the ratio of raw amounts when both sides have 18 decimals', () => {
    expect(priceFromSqrt(Q96, true)).toBe(1);
    expect(priceFromSqrt(2n * Q96, true)).toBe(4);
    expect(priceFromSqrt(2n * Q96, false)).toBe(0.25);
  });

  it('is scaled by the quote’s decimals: 10^12 more for a 6-decimal quote', () => {
    // 1 raw unit of quote per raw unit of token = 10^12 quote units per token.
    expect(priceFromSqrt(Q96, true, 6)).toBe(1e12);
    // A token at 0.5 USDC: 0.5e6 raw quote per 1e18 raw token.
    const sqrt = BigInt(Math.round(Math.sqrt(0.5e6 / 1e18) * 2 ** 96));
    expect(priceFromSqrt(sqrt, true, 6)).toBeCloseTo(0.5, 9);
  });

  it('is 0 when the value gives none', () => {
    expect(priceFromSqrt(0n, true)).toBe(0);
    expect(priceFromSqrt(0n, false)).toBe(0);
  });
});

describe('a V3 pool trade', () => {
  const pool = ADDR('f');
  // The token sorts before the quote: it is currency 0.
  const token = ADDR('1');
  const markets = new Map<string, LaunchMarket>([[pool, { token, launchpad: 'Chainzy', quote: SIGNAL_WHYPE }]]);
  const swap = (sqrt: bigint) =>
    decodeLaunchTrade(
      log({ topic0: LAUNCHPAD_TOPICS.v3Swap, address: pool, data: `0x${int(-1000n * E18)}${int(2n * E18)}${uint(sqrt)}${uint(1n)}${int(0n)}` }),
      markets
    );

  it('is stored at the pool’s price after the swap', () => {
    expect(swap(2n * Q96)).toMatchObject({ token, venue: 'v3', is_buy: true, price: 4, quote_amount: (2n * E18).toString(), token_amount: (1000n * E18).toString() });
  });

  it('is stored at what it paid per token when the event gives no price, never at 0', () => {
    // 2 HYPE for 1,000 tokens.
    expect(swap(0n)?.price).toBeCloseTo(0.002, 12);
  });
});

describe('a trade on a 6-decimal quote', () => {
  it('a V4 pool: the price is in the quote’s units', () => {
    const manager = '0x889a96eedb1df35a012d7e48baf7f9c780f1243b';
    const poolId = `0x${'7'.repeat(64)}`;
    // The token sorts before the test USDC (0xe83c...): it is currency 0.
    const token = ADDR('1');
    const markets = new Map<string, LaunchMarket>([[poolId, { token, launchpad: 'Signal', quote: NEURIIO_USDC }]]);
    const sqrt = BigInt(Math.round(Math.sqrt(0.5e6 / 1e18) * 2 ** 96));
    const trade = decodeLaunchTrade(
      log({ topic0: LAUNCHPAD_TOPICS.v4Swap, address: manager, topic1: poolId, data: `0x${int(1000n * E18)}${int(-500n * 10n ** 6n)}${uint(sqrt)}${uint(1n)}${int(0n)}${uint(0n)}` }),
      markets
    );
    expect(trade).toMatchObject({ token, venue: 'v4', is_buy: true });
    expect(trade?.price).toBeCloseTo(0.5, 9);
  });

  it('a Signal curve: what was paid is read with the quote’s decimals', () => {
    const router = '0x75d98c98f92d1f5d65ca6a962f36476be34c64ae';
    const curve = ADDR('c');
    const markets = new Map<string, LaunchMarket>([[curve, { token: ADDR('1'), launchpad: 'Signal', quote: NEURIIO_USDC }]]);
    // A buy: 250 USDC in (6 decimals), 1,000 tokens out, on the curve (venue 0).
    const trade = decodeLaunchTrade(
      log({ topic0: LAUNCHPAD_TOPICS.signalRouterTrade, address: router, topic1: topicOf(curve), data: `0x${uint(1n)}${uint(250n * 10n ** 6n)}${uint(1000n * E18)}${uint(0n)}` }),
      markets
    );
    expect(trade).toMatchObject({ venue: 'curve', is_buy: true });
    expect(trade?.price).toBeCloseTo(0.25, 12);
  });
});
