/**
 * How a market that no longer trades ended: its settlement, else its last
 * traded prices, only when every traded leg points the same way. Prices are
 * real endings of the old markets (2026-05/06).
 */
import {
  latestSettlement,
  resolutionMarket,
  winnerFromFinalPrices,
  winnerFromSettlements,
  type Hip4ResolutionMarket,
} from '../../../src/utils/hip4-resolution.util';
import type { Hip4QuestionWithOutcomes, RawHip4Settlement } from '../../../src/utils/hip4-enrichment.util';

const outcome = (outcome_id: number, display_name: string, coin?: string) => ({
  outcome_id,
  side_name: display_name,
  display_name,
  mid_price: null,
  volume_24h: null,
  total_volume: null,
  open_interest: null,
  is_settled: false,
  settled_at: null,
  ...(coin ? { coin } : {}),
});

const question = (question_id: number | null, outcomes: ReturnType<typeof outcome>[]): Hip4QuestionWithOutcomes => ({
  question_id,
  title: 'Q',
  description: null,
  class: null,
  underlying: null,
  outcome_count: outcomes.length,
  total_volume: 0,
  created_at: null,
  resolved_at: null,
  status: 'live',
  singleton_outcome_id: null,
  expiry: null,
  period: null,
  target_price: null,
  outcomes,
});

const settlement = (outcome_id: number, fields: Partial<RawHip4Settlement>): RawHip4Settlement => ({
  outcome_id,
  ...fields,
});

describe('winnerFromFinalPrices', () => {
  describe('the two sides of a market', () => {
    it.each([
      ['PSG pinned at 99.99%', [0.99991, 0.00009], 0],
      ['No at 99.9%', [0.0002, 0.999], 1],
      ['NBA Game 3, 99.1% / 0.9%', [0.991, 0.009], 0],
      ['only the losing side traded', [null, 0.001], 0],
      ['only the winning side traded', [0.999, null], 0],
    ])('names the winner: %s', (_label, prices, winner) => {
      expect(winnerFromFinalPrices(prices, true)).toBe(winner);
    });

    it.each([
      ['an undecided ending', [0.6, 0.4]],
      ['one decided side, the other in between', [0.99, 0.5]],
      ['both sides claiming the win', [0.99, 0.98]],
      ['no trade at all', [null, null]],
    ])('names none: %s', (_label, prices) => {
      expect(winnerFromFinalPrices(prices, true)).toBeNull();
    });
  });

  describe('the outcomes of a question', () => {
    it.each([
      ['a bucket at 100%', [0, 1, 0.001], 1],
      ['a loser at 4.999% still counts as lost', [0.04999, 0.999, 0.0002], 1],
      ['untraded outcomes are left out', [null, 0.99, null], 1],
    ])('names the winner: %s', (_label, prices, winner) => {
      expect(winnerFromFinalPrices(prices, false)).toBe(winner);
    });

    it.each([
      ['BTC on Jun 5 ended at 80% / 27.6%', [0.8, 0.276, 0]],
      ['two outcomes at the top', [0.99, 0.98, 0]],
      ['a winner but another outcome in between', [0.99, 0.3]],
      ['every outcome at the bottom', [0.001, 0.002]],
    ])('names none: %s', (_label, prices) => {
      expect(winnerFromFinalPrices(prices, false)).toBeNull();
    });
  });
});

describe('winnerFromSettlements', () => {
  const sides: Hip4ResolutionMarket = {
    sides: true,
    status: 'settled',
    legs: [{ coin: '#1540', outcomeId: 154 }, { coin: '#1541', outcomeId: 154 }],
  };
  const outcomes: Hip4ResolutionMarket = {
    sides: false,
    status: 'settled',
    legs: [{ coin: '#3000', outcomeId: 300 }, { coin: '#3010', outcomeId: 301 }, { coin: '#3020', outcomeId: 302 }],
  };

  it('reads a market from its outcome settle fraction: 1 is Yes (side 0), 0 is side 1', () => {
    expect(winnerFromSettlements(sides, new Map([[154, settlement(154, { settle_fraction: 1 })]]))).toBe(0);
    expect(winnerFromSettlements(sides, new Map([[154, settlement(154, { settle_fraction: 0 })]]))).toBe(1);
    expect(winnerFromSettlements(sides, new Map([[154, settlement(154, { winner_side: 1 })]]))).toBe(1);
  });

  it('names no winner for a split payout or a missing settlement', () => {
    expect(winnerFromSettlements(sides, new Map([[154, settlement(154, { settle_fraction: 0.5 })]]))).toBeNull();
    expect(winnerFromSettlements(sides, new Map([[154, null]]))).toBeNull();
    expect(winnerFromSettlements(sides, new Map())).toBeNull();
  });

  it('reads a question from the one outcome settled at 1', () => {
    const settled = new Map([
      [300, settlement(300, { settle_fraction: 0 })],
      [301, settlement(301, { settle_fraction: 1 })],
      [302, null],
    ]);
    expect(winnerFromSettlements(outcomes, settled)).toBe(1);
    settled.set(302, settlement(302, { settle_fraction: 1 }));
    expect(winnerFromSettlements(outcomes, settled)).toBeNull();
  });
});

describe('resolutionMarket', () => {
  it('reads a standalone market on its two side coins', () => {
    const m = resolutionMarket(question(null, [outcome(110, 'PSG', '#1100'), outcome(110, 'Arsenal', '#1101')]));
    expect(m).toEqual({
      sides: true,
      status: 'live',
      legs: [{ coin: '#1100', outcomeId: 110 }, { coin: '#1101', outcomeId: 110 }],
    });
  });

  it('reads a question on its outcomes\' Yes coins, without the residual outcome', () => {
    const m = resolutionMarket(
      question(50, [outcome(300, 'Below 4.3%'), outcome(301, 'Above 4.3%'), outcome(302, 'Other / Disputed')])
    );
    expect(m.sides).toBe(false);
    expect(m.legs).toEqual([{ coin: '#3000', outcomeId: 300 }, { coin: '#3010', outcomeId: 301 }]);
  });
});

describe('latestSettlement', () => {
  it('keeps the outcome\'s latest record and ignores other outcomes', () => {
    const rows = [
      settlement(154, { settle_fraction: 1, block_time: '2026-06-05T06:00:01' }),
      settlement(154, { settle_fraction: 0, block_time: '2026-06-05T06:00:04' }),
      settlement(999, { settle_fraction: 1, block_time: '2026-06-06T06:00:00' }),
    ];
    expect(latestSettlement(rows, 154)).toMatchObject({ settle_fraction: 0 });
    expect(latestSettlement(rows, 155)).toBeNull();
  });

  it('compares times in UTC whatever their format, then block height', () => {
    const rows = [
      settlement(154, { settle_fraction: 1, settled_at: '2026-06-05T06:00:09Z' }),
      settlement(154, { settle_fraction: 0, block_time: '2026-06-05 06:00:04' }),
    ];
    expect(latestSettlement(rows, 154)).toMatchObject({ settle_fraction: 1 });
    const tie = [
      settlement(154, { settle_fraction: 1, block_time: '2026-06-05T06:00:04', block_height: 10 }),
      settlement(154, { settle_fraction: 0, block_time: '2026-06-05T06:00:04Z', block_height: 12 }),
    ];
    expect(latestSettlement(tie, 154)).toMatchObject({ settle_fraction: 0 });
  });
});
