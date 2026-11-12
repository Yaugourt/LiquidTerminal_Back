/**
 * What is kept of elysium_tx, the pure part: which day is final, which days are folded next,
 * the keep and its floor, the names of the day tables, and which of them may be dropped.
 */
// CHECK_DAYS lives beside the daily comparison, whose module opens the database: not here.
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {}, prismaHistoricalAggregate: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CHECK_DAYS } from '../../../src/services/elysium/elysium-day-check.service';
import { ROLLUP_CALLERS_KEEP_DAYS, ROLLUP_KEEP_DAYS } from '../../../src/services/elysium/elysium-rollup.util';
import {
  daysToFold,
  FACTS_FINAL_DAYS,
  finalDay,
  firstKeptTxDay,
  LATE_ROW_AGE_MS,
  partitionDay,
  partitionDaysWanted,
  partitionName,
  PARTITIONS_AHEAD_DAYS,
  partitionsToDrop,
  TX_KEEP_MIN_DAYS,
  TX_KEEP_NO_ROLLUP_DAYS,
  txKeepDays,
  type TxPartition,
} from '../../../src/services/elysium/elysium-retention.util';

const DAY = 86_400_000;
const at = (iso: string): Date => new Date(iso);
const ms = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const dayPart = (day: string): TxPartition => ({ name: partitionName(day), fromMs: ms(day), toMs: ms(day) + DAY });

describe('a final day', () => {
  it('leaves the daily comparison its days, with two to spare', () => {
    expect(CHECK_DAYS + 2).toBeLessThanOrEqual(FACTS_FINAL_DAYS);
  });

  it('is the day that ended FACTS_FINAL_DAYS days ago, once the tx stream has caught up', () => {
    const now = at('2026-11-12T15:00:00Z');
    expect(finalDay(now, { cursor: at('2026-11-12T14:59:40Z'), backfillDone: true })).toBe('2026-11-02');
    // One second before and after midnight.
    expect(finalDay(at('2026-11-12T23:59:59Z'), { cursor: at('2026-11-12T23:59:50Z'), backfillDone: true })).toBe('2026-11-02');
    expect(finalDay(at('2026-11-13T00:00:01Z'), { cursor: at('2026-11-13T00:00:00Z'), backfillDone: true })).toBe('2026-11-03');
  });

  it('does not exist while the tx stream loads its history, or has no cursor', () => {
    const now = at('2026-11-12T15:00:00Z');
    expect(finalDay(now, null)).toBeNull();
    expect(finalDay(now, { cursor: at('2026-10-01T00:00:00Z'), backfillDone: false })).toBeNull();
    expect(finalDay(now, { cursor: null, backfillDone: true })).toBeNull();
  });

  it('is held back by a tx stream that stands still', () => {
    // The provider stalled five days ago: the days the stream has not confirmed are not final.
    expect(finalDay(at('2026-11-12T15:00:00Z'), { cursor: at('2026-11-07T12:00:00Z'), backfillDone: true })).toBe('2026-10-28');
  });

  it('every row of a day that can be folded takes the insert path that knows the facts', () => {
    // The newest row of the newest final day, at the first instant that day is final.
    const now = at('2026-11-13T00:00:00.000Z');
    const final = finalDay(now, { cursor: now, backfillDone: true }) as string;
    const newestRow = ms(final) + DAY - 1;
    expect(newestRow).toBeLessThan(now.getTime() - LATE_ROW_AGE_MS);
  });
});

describe('the days folded next', () => {
  it('start at the first day ever when nothing was folded, at the day after the last one otherwise', () => {
    expect(daysToFold(null, '2026-09-11', '2026-09-13', 10)).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
    expect(daysToFold('2026-09-12', '2026-09-11', '2026-09-14', 10)).toEqual(['2026-09-13', '2026-09-14']);
  });

  it('are none when the facts are up to date, or no day is final', () => {
    expect(daysToFold('2026-09-14', '2026-09-11', '2026-09-14', 10)).toEqual([]);
    expect(daysToFold('2026-09-12', '2026-09-11', null, 10)).toEqual([]);
    expect(daysToFold(null, '2026-09-20', '2026-09-14', 10)).toEqual([]);
  });

  it('stop at the count asked, and cross a month', () => {
    expect(daysToFold('2026-09-29', '2026-09-11', '2026-10-20', 3)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('the keep', () => {
  it('is none unless ELYSIUM_TX_KEEP_DAYS is a positive whole number', () => {
    for (const v of [undefined, '', ' ', '0', '-5', '12.5', 'forever', '1e3']) {
      expect(txKeepDays({ ELYSIUM_TX_KEEP_DAYS: v } as NodeJS.ProcessEnv)).toBeNull();
    }
    expect(txKeepDays({ ELYSIUM_TX_KEEP_DAYS: '90' } as NodeJS.ProcessEnv)).toBe(90);
    expect(txKeepDays({ ELYSIUM_TX_KEEP_DAYS: ' 45 ' } as NodeJS.ProcessEnv)).toBe(45);
  });

  it('never goes under what the views read from elysium_tx', () => {
    expect(TX_KEEP_MIN_DAYS).toBe(ROLLUP_CALLERS_KEEP_DAYS + 1);
    expect(txKeepDays({ ELYSIUM_TX_KEEP_DAYS: '7' } as NodeJS.ProcessEnv)).toBe(TX_KEEP_MIN_DAYS);
    // Without the day rollups the widest reads go back to elysium_tx itself.
    expect(TX_KEEP_NO_ROLLUP_DAYS).toBeGreaterThanOrEqual(ROLLUP_KEEP_DAYS);
    expect(txKeepDays({ ELYSIUM_TX_KEEP_DAYS: '40' } as NodeJS.ProcessEnv, false)).toBe(TX_KEEP_NO_ROLLUP_DAYS);
  });

  it('counts whole days before today', () => {
    expect(firstKeptTxDay(at('2026-11-12T00:00:00Z'), 35)).toBe('2026-10-08');
    expect(firstKeptTxDay(at('2026-11-12T23:59:59Z'), 35)).toBe('2026-10-08');
  });
});

describe('the day tables', () => {
  it('are named after their day, and only their names are read back as days', () => {
    expect(partitionName('2026-11-12')).toBe('elysium_tx_d20261112');
    expect(partitionDay('elysium_tx_d20261112')).toBe('2026-11-12');
    for (const name of ['elysium_tx_legacy', 'elysium_tx_d2026111', 'elysium_tx_d20261340', 'elysium_tx_d20261112x', 'elysium_tx_live']) {
      expect(partitionDay(name)).toBeNull();
    }
    expect(() => partitionName('2026-11-12; DROP TABLE x')).toThrow();
  });

  it('are wanted for today and the days ahead, from the day the split starts', () => {
    const wanted = partitionDaysWanted(at('2026-11-12T23:50:00Z'), '2026-11-13');
    expect(wanted).toEqual(['2026-11-13', '2026-11-14', '2026-11-15']);
    expect(partitionDaysWanted(at('2026-11-12T00:00:00Z'), '2026-11-01')).toHaveLength(PARTITIONS_AHEAD_DAYS + 1);
  });
});

describe('the day tables that may be dropped', () => {
  const now = at('2026-11-12T10:00:00Z');
  const keep = 35; // first kept day: 2026-10-08
  const built = (from: string, to: string): Set<string> => {
    const out = new Set<string>();
    for (let d = ms(from); d <= ms(to); d += DAY) out.add(new Date(d).toISOString().slice(0, 10));
    return out;
  };
  const allBuilt = built('2026-09-01', '2026-11-11');
  const parts = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map(dayPart);

  it('are the ones wholly before the first kept day, oldest first', () => {
    expect(partitionsToDrop(parts, now, keep, '2026-11-02', allBuilt).map((p) => p.name)).toEqual([
      'elysium_tx_d20261005',
      'elysium_tx_d20261006',
      'elysium_tx_d20261007',
    ]);
  });

  it('are none while the history facts do not hold them', () => {
    expect(partitionsToDrop(parts, now, keep, null, allBuilt)).toEqual([]);
    expect(partitionsToDrop(parts, now, keep, '2026-10-05', allBuilt).map((p) => p.name)).toEqual(['elysium_tx_d20261005']);
  });

  it('wait for the rollup of their day, which the views read in their place', () => {
    const missing = new Set(allBuilt);
    missing.delete('2026-10-06');
    expect(partitionsToDrop(parts, now, keep, '2026-11-02', missing).map((p) => p.name)).toEqual(['elysium_tx_d20261005', 'elysium_tx_d20261007']);
  });

  it('no longer wait for a rollup once no view reads that far back', () => {
    // 2026-09-01 is past the days the rollups are kept for: nothing asks for its rollup.
    const old = [dayPart('2026-09-01')];
    expect(partitionsToDrop(old, now, keep, '2026-11-02', new Set())).toHaveLength(1);
  });

  it('take the table of everything before the split only when all of it is out of the keep', () => {
    const legacyKept: TxPartition = { name: 'elysium_tx_legacy', fromMs: null, toMs: ms('2026-10-09') };
    const legacyOut: TxPartition = { name: 'elysium_tx_legacy', fromMs: null, toMs: ms('2026-10-08') };
    expect(partitionsToDrop([legacyKept], now, keep, '2026-11-02', allBuilt)).toEqual([]);
    expect(partitionsToDrop([legacyOut], now, keep, '2026-11-02', allBuilt)).toEqual([legacyOut]);
    // One of its days inside the rollups' span is not built: it stays.
    const missing = new Set(allBuilt);
    missing.delete('2026-10-01');
    expect(partitionsToDrop([legacyOut], now, keep, '2026-11-02', missing)).toEqual([]);
  });
});
