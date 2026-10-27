import { totalMarketCapPerToken } from '../../../src/utils/spot-market-cap.util';
import type { MarketData } from '../../../src/types/market.types';

const pair = (tokenId: string, quote: string, marketCap: number, name = `${tokenId}/${quote}`): MarketData =>
  ({ name, tokenId, quote, marketCap }) as MarketData;

describe('totalMarketCapPerToken', () => {
  it('counts a token with several pairs once, from its USDC pair', () => {
    const total = totalMarketCapPerToken([
      pair('HYPE', 'USDC', 24.48),
      pair('HYPE', 'USDT0', 24.52),
      pair('HYPE', 'USDH', 19.06),
      pair('PURR', 'USDC', 1),
    ]);
    expect(total).toBeCloseTo(25.48);
  });

  it('takes the largest pair when a token has no USDC pair', () => {
    expect(totalMarketCapPerToken([pair('A', 'USDH', 5), pair('A', 'USDE', 7)])).toBe(7);
  });

  it('adds distinct tokens', () => {
    expect(totalMarketCapPerToken([pair('A', 'USDC', 5), pair('B', 'USDC', 7)])).toBe(12);
  });

  it('keeps rows without a token id apart and ignores non-finite caps', () => {
    expect(
      totalMarketCapPerToken([
        pair('', 'USDC', 2, 'X/USDC'),
        pair('', 'USDC', 3, 'Y/USDC'),
        pair('Z', 'USDC', Number.NaN),
      ])
    ).toBe(5);
  });

  it('is zero for no markets', () => {
    expect(totalMarketCapPerToken([])).toBe(0);
  });
});
