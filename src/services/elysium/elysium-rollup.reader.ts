import { Prisma, type PrismaClient } from '../../../prisma-historical/generated/client';
import { prismaHistoricalAggregate } from '../../core/prisma.historical.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { planRollupWindow, rollupKeepDays, firstKeptDay } from './elysium-rollup.util';
import type { RollupDayCoverage, RollupNeed, RollupPlan } from './elysium-rollup.util';
import type { RollupBuiltAt, WindowState } from './elysium-window.util';
import { toWindowState } from '../../repositories/prisma/prisma.elysium-window.repository';

/**
 * Read side of the Elysium rollups: which days and hours are built, what the
 * window tables stand for, and the SQL pieces a query needs to read a window
 * as "built days from the day rollups, built hours from the hour rollups, the
 * rest from elysium_tx".
 */

/** ELYSIUM_ROLLUPS_ENABLED=false: nothing is built and nothing is read from the rollups. */
export function rollupsEnabled(): boolean {
  return (process.env.ELYSIUM_ROLLUPS_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * ELYSIUM_WINDOWS_ENABLED=false: the window tables are neither built nor read; every view
 * computes from the day and hour rollups, as it does while a table is not ready.
 */
export function windowsEnabled(): boolean {
  return rollupsEnabled() && (process.env.ELYSIUM_WINDOWS_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

/** The list of built days could not be read: the computation that needed it is given up. */
export class RollupCoverageUnreadableError extends Error {
  constructor() {
    super('ELYSIUM_ROLLUP_COVERAGE_UNREADABLE');
    this.name = 'RollupCoverageUnreadableError';
  }
}

/** What a computation knows of the rollups when it starts. */
export interface RollupCoverage {
  /** The built, non-dirty days. */
  days: Map<string, RollupDayCoverage>;
  /** The built, non-dirty hours (epoch ms of their start). */
  hours: Set<number>;
  /** Build time of every built day and hour, dirty ones included: what a window table was read from. */
  built: RollupBuiltAt;
  /** The window tables' states, per span. Empty when the tables are switched off. */
  windows: Map<number, WindowState>;
  /** The contract-removal counter the window tables' classes are checked against. */
  epoch: string;
}

export function emptyRollupCoverage(): RollupCoverage {
  return { days: new Map(), hours: new Set(), built: { days: new Map(), hours: new Map() }, windows: new Map(), epoch: '0' };
}

interface CoverageRow {
  kind: 'day' | 'hour' | 'window';
  key: string;
  at: number | null;
  dirty: boolean;
  callers: boolean;
  senders: boolean;
  state: Record<string, unknown> | null;
}

/**
 * The built days and hours and the window tables' states. Read at the start
 * of every computation, never cached: a day marked dirty stops being used by
 * the next one.
 *
 * A read that fails throws by default. It used to answer "no day built", which
 * sent the whole window to elysium_tx: when the pool was saturated the read
 * failed, fees over 30 days went back to 38 million rows for minutes, and the
 * overload fed itself. A scheduled view that cannot read the list is given up
 * and keeps its last value. `onFailure: 'raw'` keeps the old answer for a read
 * that is bounded whatever the plan (one contract's own rows).
 */
export async function readRollupCoverage(
  now: Date,
  options: { db?: PrismaClient; onFailure?: 'throw' | 'raw' } = {}
): Promise<RollupCoverage> {
  const coverage = emptyRollupCoverage();
  if (!rollupsEnabled()) return coverage;
  try {
    const rows = await (options.db ?? prismaHistoricalAggregate).$queryRaw<CoverageRow[]>`
      SELECT 'day' AS kind, day::text AS key, round(extract(epoch FROM built_at) * 1000)::float8 AS at,
             dirty, callers_built AS callers, senders_built AS senders, NULL::jsonb AS state
      FROM elysium_day_rollup
      WHERE built_at IS NOT NULL AND day >= ${firstKeptDay(now, rollupKeepDays())}::date
      UNION ALL
      SELECT 'hour', round(extract(epoch FROM hour) * 1000)::bigint::text, round(extract(epoch FROM built_at) * 1000)::float8,
             dirty, false, false, NULL::jsonb
      FROM elysium_hour_rollup
      WHERE built_at IS NOT NULL
      UNION ALL
      SELECT 'window', span::text, NULL::float8, false, false, false,
             jsonb_build_object('span', span, 'version', version::text, 'ready', ready, 'epoch', epoch::text,
                                'base_days', base_days, 'cover_days', cover_days, 'cover_hours', cover_hours,
                                'refreshed_ms', round(extract(epoch FROM refreshed_at) * 1000)::float8)
      FROM elysium_window_state`;
    const days = coverage.built.days as Map<string, number>;
    const hours = coverage.built.hours as Map<number, number>;
    const windows = windowsEnabled();
    for (const r of rows) {
      if (r.kind === 'day') {
        const day = r.key.slice(0, 10);
        days.set(day, Math.round(Number(r.at)));
        if (!r.dirty) coverage.days.set(day, { callers: r.callers, senders: r.senders });
      } else if (r.kind === 'hour') {
        const hour = Number(r.key);
        hours.set(hour, Math.round(Number(r.at)));
        if (!r.dirty) coverage.hours.add(hour);
      } else if (r.state) {
        const state = toWindowState(r.state as unknown as Parameters<typeof toWindowState>[0]);
        if (state.span === 0) coverage.epoch = state.version;
        else if (windows) coverage.windows.set(state.span, state);
      }
    }
  } catch (error) {
    if (options.onFailure !== 'raw') {
      logDeduplicator.warn('Elysium rollups: coverage unreadable, computation given up', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw new RollupCoverageUnreadableError();
    }
    logDeduplicator.warn('Elysium rollups: coverage unreadable, reading the raw table', {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return emptyRollupCoverage();
  }
  return coverage;
}

/**
 * [start, end) split for a read that has the coverage in hand: built days, then built hours
 * (for the call sums only: the hour rollups hold no sender list), then elysium_tx.
 */
export function planWindow(start: Date, end: Date, coverage: RollupCoverage, need: RollupNeed = 'calls'): RollupPlan {
  return planRollupWindow(start, end, coverage.days, need, coverage.hours);
}

/** `day = ANY(...)` operand: the plan's rollup days as a date array. */
export function rollupDays(plan: RollupPlan): Prisma.Sql {
  return Prisma.sql`${plan.days}::text[]::date[]`;
}

/** `hour = ANY(...)` operand: the plan's rollup hours as a timestamptz array. */
export function rollupHours(plan: RollupPlan): Prisma.Sql {
  return Prisma.sql`${plan.hours.map((h) => new Date(h).toISOString())}::text[]::timestamptz[]`;
}

/**
 * Predicate selecting the plan's raw ranges on a timestamptz column, e.g.
 * `(t.block_time >= a AND t.block_time < b) OR (...)`, or FALSE when the plan
 * has none. Timestamps cross the driver as ISO text (see ElysiumIngestRepository).
 */
export function rawRanges(column: Prisma.Sql, plan: RollupPlan): Prisma.Sql {
  if (plan.raw.length === 0) return Prisma.sql`FALSE`;
  const parts = plan.raw.map(
    (r) => Prisma.sql`(${column} >= ${r.from.toISOString()}::timestamptz AND ${column} < ${r.to.toISOString()}::timestamptz)`
  );
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

const DAY_MS = 86_400_000;

/**
 * Distinct non-spam senders to each of `addresses` over [start, end).
 * On the built days a busy target's senders come from its day lists; a target
 * with no list for a day (fewer than ROLLUP_CALLER_SET_MIN_TXS transactions
 * then) is read from elysium_tx for that day alone, and so is everything
 * outside the built days.
 *
 * Two statements: the first names the (target, day) pairs without a list, the
 * second reads elysium_tx one explicit (target, time range) at a time. As one
 * statement the planner probed elysium_tx by target only and filtered the day
 * afterwards: every transaction the target ever received, once per day.
 *
 * `db`: the pool the statements run on, the scheduled aggregates' by default.
 */
export async function distinctCallers(
  addresses: string[],
  start: Date,
  end: Date,
  coverage: RollupCoverage,
  db: PrismaClient = prismaHistoricalAggregate
): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();
  const plan = planRollupWindow(start, end, coverage.days, 'callers');
  const days = rollupDays(plan);

  // Built days on which a target was called but has no caller list.
  const quiet = plan.days.length
    ? await db.$queryRaw<Array<{ address: string; day: string }>>`
        SELECT a.address, d.day::text AS day
        FROM unnest(${addresses}::text[]) AS a(address)
        CROSS JOIN unnest(${days}) AS d(day)
        WHERE NOT EXISTS (SELECT 1 FROM elysium_caller_set s WHERE s.day = d.day AND s.to_addr = a.address)
          AND EXISTS (SELECT 1 FROM elysium_call_day c WHERE c.day = d.day AND c.to_addr = a.address)
        ORDER BY a.address, d.day`
    : [];

  // What is read from elysium_tx, per target: the window's raw ranges, and its quiet days
  // (consecutive ones as one range).
  const probes: Array<{ address: string; from: number; to: number }> = [];
  for (const address of addresses) {
    for (const r of plan.raw) probes.push({ address, from: r.from.getTime(), to: r.to.getTime() });
  }
  for (const row of quiet) {
    const from = Date.parse(`${row.day.slice(0, 10)}T00:00:00Z`);
    const last = probes[probes.length - 1];
    if (last && last.address === row.address && last.to === from) last.to = from + DAY_MS;
    else probes.push({ address: row.address, from, to: from + DAY_MS });
  }
  const probeAddrs = probes.map((p) => p.address);
  const probeFrom = probes.map((p) => new Date(p.from).toISOString());
  const probeTo = probes.map((p) => new Date(p.to).toISOString());

  // Each (target, sender) pair once, then the pairs per target: count(DISTINCT) sorted every row
  // read (hundreds of thousands for the busiest targets), on disk.
  const rows = await hashGrouped(
    db,
    (tx) => tx.$queryRaw<Array<{ address: string; callers: number }>>`
      SELECT address, count(*)::int AS callers FROM (
        SELECT address, from_addr FROM (
          SELECT p.to_addr AS address, p.from_addr
          FROM elysium_caller_day p
          WHERE p.day = ANY(${days}) AND p.to_addr = ANY(${addresses}::text[])
          UNION ALL
          SELECT x.to_addr, x.from_addr
          FROM unnest(${probeAddrs}::text[], ${probeFrom}::text[]::timestamptz[], ${probeTo}::text[]::timestamptz[])
               AS q(address, range_from, range_to)
          CROSS JOIN LATERAL (
            SELECT t.to_addr, t.from_addr FROM elysium_tx t
            WHERE t.to_addr = q.address AND t.block_time >= q.range_from AND t.block_time < q.range_to
              AND NOT t.is_spam
          ) x
        ) u GROUP BY address, from_addr
      ) d GROUP BY address`
  );
  return new Map(rows.map((r) => [r.address, r.callers]));
}

/** Limits of the transaction a statement with its own settings runs in: the statement's own limit is the pool's. */
const SETTINGS_TX_TIMEOUT_MS = 660_000;
/** The aggregates' pool lets a statement wait longer than a statement may run for a connection: so does this. */
const SETTINGS_TX_MAX_WAIT_MS = 660_000;
/**
 * Sort and hash memory of a statement that asks for it (Postgres' work_mem; a hash may take
 * twice that). The server's default, 4 MB, sent the groupings of the wide views, a million
 * addresses or senders, through files on disk. Asked for by the statement, in its own
 * transaction, never for a whole pool (see prisma.historical.service).
 */
const STATEMENT_WORK_MEM = '64MB';

type HistoricalTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Runs one statement with more sort and hash memory than the pool's default. The transaction's
 * limits are given: Prisma ends one after 5 seconds by default, less than these statements take
 * on the production database.
 */
export async function withWorkMem<T>(db: PrismaClient, run: (tx: HistoricalTx) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL work_mem = '${STATEMENT_WORK_MEM}'`);
      return run(tx);
    },
    { timeout: SETTINGS_TX_TIMEOUT_MS, maxWait: SETTINGS_TX_MAX_WAIT_MS }
  );
}

/**
 * Runs one grouping statement with more memory and the planner told not to sort. A distinct
 * count over a million rows is quick as a hash of the pairs; the planner, which cannot know
 * how many of the rows repeat, expects the hash not to fit in memory and sorts them all
 * instead, on disk (three times slower, measured 2026-11-12). The settings hold for this
 * statement only (its own transaction); a hash that does outgrow its memory goes to disk by
 * parts, and still ends. Not for a statement that puts many rows in order: an ORDER BY is
 * still a sort (the planner has no other way), which is fine for the last few rows of a top
 * list and no more.
 */
export async function hashGrouped<T>(db: PrismaClient, run: (tx: HistoricalTx) => Promise<T>): Promise<T> {
  return withWorkMem(db, async (tx) => {
    await tx.$executeRaw`SET LOCAL enable_sort = off`;
    return run(tx);
  });
}

export { planRollupWindow };
export type { RollupDayCoverage, RollupPlan };
