/**
 * Filters of the anonymous `liquidation` subscription are untrusted input that
 * the broadcast loop evaluates for every liquidation: they are shaped and
 * bounded on subscribe.
 */
import {
  normalizeLiquidationFilters,
  MAX_FILTER_COINS,
  MAX_FILTER_WALLETS,
  MAX_FILTER_COIN_LENGTH,
  MAX_FILTER_WALLET_LENGTH,
} from '../../../src/websocket/liquidationFilters';

describe('normalizeLiquidationFilters', () => {
  it.each([undefined, null, {}])('treats %p as no filter', (raw) => {
    expect(normalizeLiquidationFilters(raw)).toEqual({ ok: true, filters: {} });
  });

  it('keeps what the front sends (coins, minAmountUsd, wallets)', () => {
    const w = '0xAbC0000000000000000000000000000000000001';
    expect(normalizeLiquidationFilters({ coins: ['btc', 'ETH'], minAmountUsd: 50_000, wallets: [w] })).toEqual({
      ok: true,
      filters: { coins: ['BTC', 'ETH'], minAmountUsd: 50_000, wallets: [w.toLowerCase()] },
    });
  });

  it('accepts empty lists and a zero minimum, treats null keys as unset', () => {
    expect(normalizeLiquidationFilters({ coins: [], wallets: [], minAmountUsd: 0 })).toEqual({
      ok: true,
      filters: { coins: [], wallets: [], minAmountUsd: 0 },
    });
    expect(normalizeLiquidationFilters({ coins: null, wallets: null, minAmountUsd: null })).toEqual({ ok: true, filters: {} });
  });

  it('upper-cases coins, lower-cases wallets, trims and deduplicates', () => {
    const r = normalizeLiquidationFilters({ coins: [' btc ', 'BTC', 'xyz:aapl', ''], wallets: ['0xAA', '0xaa'] });
    expect(r).toEqual({ ok: true, filters: { coins: ['BTC', 'XYZ:AAPL'], wallets: ['0xaa'] } });
  });

  it('drops unknown keys', () => {
    const r = normalizeLiquidationFilters({ coins: ['BTC'], __proto__x: 1, evil: { a: 1 }, padding: 'x'.repeat(1000) });
    expect(r).toEqual({ ok: true, filters: { coins: ['BTC'] } });
  });

  it.each([
    ['a string instead of an array', { coins: 'BTC' }],
    ['a number entry', { coins: [1] }],
    ['an object entry', { wallets: [{}] }],
    ['a nested array entry', { coins: [['BTC']] }],
    ['a string wallets', { wallets: '0xabc' }],
    ['a string minAmountUsd', { minAmountUsd: '1000' }],
    ['a negative minAmountUsd', { minAmountUsd: -1 }],
    ['NaN', { minAmountUsd: NaN }],
    ['Infinity', { minAmountUsd: Infinity }],
    ['too many coins', { coins: Array.from({ length: MAX_FILTER_COINS + 1 }, (_, i) => `C${i}`) }],
    ['too many wallets', { wallets: Array.from({ length: MAX_FILTER_WALLETS + 1 }, (_, i) => `0x${i}`) }],
    ['a huge coin', { coins: ['A'.repeat(MAX_FILTER_COIN_LENGTH + 1)] }],
    ['a huge wallet', { wallets: ['0'.repeat(MAX_FILTER_WALLET_LENGTH + 1)] }],
    ['an array as filters', ['BTC']],
    ['a string as filters', 'BTC'],
    ['a number as filters', 5],
  ])('refuses %s', (_label, raw) => {
    const r = normalizeLiquidationFilters(raw);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/^Invalid filters:/);
  });

  it('accepts exactly the limits', () => {
    const coins = Array.from({ length: MAX_FILTER_COINS }, (_, i) => `C${i}`);
    const wallets = Array.from({ length: MAX_FILTER_WALLETS }, (_, i) => `0x${i}`);
    expect(normalizeLiquidationFilters({ coins, wallets }).ok).toBe(true);
  });
});
