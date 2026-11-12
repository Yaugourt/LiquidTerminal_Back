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
import { ROLLUP_KEEP_DAYS, rollupKeepDays } from '../../../src/services/elysium/elysium-rollup.util';
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
    expect(txKeepDays({ ELYSIUM_TX_KEEP_DAYS: ' 120 ' } as NodeJS.ProcessEnv)).toBe(120);
  });

  it('never goes under what the views can read from elysium_tx: 60 days and the partial day before them', () => {
    expect(TX_KEEP_MIN_DAYS).toBeGreaterThanOrEqual(61);
    expect(TX_KEEP_MIN_DAYS).toBeGreaterThanOrEqual(ROLLUP_KEEP_DAYS);
    for (const asked of ['7', '35', '60']) {
      expect(txKeepDays({ ELYSIUM_TX_KEEP_DAYS: asked } as NodeJS.ProcessEnv)).toBe(TX_KEEP_MIN_DAYS);
    }
  });

  it('holds the rollups to their full span: a rollup day dropped could not be built again', () => {
    const before = { keep: process.env.ELYSIUM_TX_KEEP_DAYS, rollups: process.env.ELYSIUM_ROLLUP_KEEP_DAYS };
    process.env.ELYSIUM_ROLLUP_KEEP_DAYS = '20';
    delete process.env.ELYSIUM_TX_KEEP_DAYS;
    expect(rollupKeepDays()).toBe(20);
    process.env.ELYSIUM_TX_KEEP_DAYS = '90';
    expect(rollupKeepDays()).toBe(ROLLUP_KEEP_DAYS);
    process.env.ELYSIUM_ROLLUP_KEEP_DAYS = '80';
    expect(rollupKeepDays()).toBe(80);
    if (before.keep === undefined) delete process.env.ELYSIUM_TX_KEEP_DAYS;
    else process.env.ELYSIUM_TX_KEEP_DAYS = before.keep;
    if (before.rollups === undefined) delete process.env.ELYSIUM_ROLLUP_KEEP_DAYS;
    else process.env.ELYSIUM_ROLLUP_KEEP_DAYS = before.rollups;
  });

  it('counts whole days before today', () => {
    expect(firstKeptTxDay(at('2026-11-12T00:00:00Z'), 65)).toBe('2026-09-08');
    expect(firstKeptTxDay(at('2026-11-12T23:59:59Z'), 65)).toBe('2026-09-08');
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
  const keep = 65; // first kept day: 2026-09-08
  const built = (from: string, to: string): Set<string> => {
    const out = new Set<string>();
    for (let d = ms(from); d <= ms(to); d += DAY) out.add(new Date(d).toISOString().slice(0, 10));
    return out;
  };
  const allBuilt = built('2026-08-01', '2026-11-11');
  const sendersAt = now.getTime();
  const parts = ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'].map(dayPart);
  const drop = (
    list: TxPartition[],
    over: { facts?: string | null; senders?: number | null; built?: Set<string>; keep?: number } = {}
  ): string[] =>
    partitionsToDrop(
      list,
      now,
      over.keep ?? keep,
      over.facts === undefined ? '2026-11-02' : over.facts,
      over.senders === undefined ? sendersAt : over.senders,
      over.built ?? allBuilt
    ).map((p) => p.name);

  it('are the ones wholly before the first kept day, oldest first', () => {
    expect(drop(parts)).toEqual(['elysium_tx_d20260905', 'elysium_tx_d20260906', 'elysium_tx_d20260907']);
    // Whatever order they are given in.
    expect(drop([...parts].reverse())).toEqual(['elysium_tx_d20260905', 'elysium_tx_d20260906', 'elysium_tx_d20260907']);
  });

  it('are none while the history facts do not hold them', () => {
    expect(drop(parts, { facts: null })).toEqual([]);
    expect(drop(parts, { facts: '2026-09-05' })).toEqual(['elysium_tx_d20260905']);
  });

  it('are none while the senders are not copied past them', () => {
    expect(drop(parts, { senders: null })).toEqual([]);
    expect(drop(parts, { senders: ms('2026-09-06') + 3_600_000 })).toEqual(['elysium_tx_d20260905']);
  });

  it('wait for the rollup of their day, and so does every day after it: no day is ever missing in the middle', () => {
    // The rule itself, shown with a keep shorter than the code ever allows (with the real floor a
    // day out of the keep is also out of the days the rollups cover).
    const recent = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map(dayPart);
    const missing = new Set(allBuilt);
    missing.delete('2026-10-06');
    expect(drop(recent, { keep: 30 })).toEqual(['elysium_tx_d20261005', 'elysium_tx_d20261006', 'elysium_tx_d20261007', 'elysium_tx_d20261008']);
    expect(drop(recent, { keep: 30, built: missing })).toEqual(['elysium_tx_d20261005']);
  });

  it('no longer wait for a rollup once no view reads that far back', () => {
    // 2026-08-01 is past the days the rollups are kept for: nothing asks for its rollup.
    expect(drop([dayPart('2026-08-01')], { built: new Set() })).toHaveLength(1);
  });

  it('take the table of everything before the split only when all of it is out of the keep', () => {
    const legacyKept: TxPartition = { name: 'elysium_tx_legacy', fromMs: null, toMs: ms('2026-09-09') };
    const legacyOut: TxPartition = { name: 'elysium_tx_legacy', fromMs: null, toMs: ms('2026-09-08') };
    expect(drop([legacyKept])).toEqual([]);
    expect(drop([legacyOut])).toEqual(['elysium_tx_legacy']);
    // A first part that stays holds back the day tables after it.
    const after = ['2026-09-09', '2026-09-10'].map(dayPart);
    const later = at('2026-11-16T10:00:00Z'); // both day tables out of the keep by then
    expect(partitionsToDrop([legacyKept, ...after], later, keep, '2026-09-07', later.getTime(), allBuilt)).toEqual([]);
    expect(partitionsToDrop([legacyKept, ...after], later, keep, '2026-11-02', later.getTime(), allBuilt).map((p) => p.name)).toEqual([
      'elysium_tx_legacy',
      'elysium_tx_d20260909',
      'elysium_tx_d20260910',
    ]);
  });
});
