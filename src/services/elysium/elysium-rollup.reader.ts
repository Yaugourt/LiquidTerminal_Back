import { Prisma, type PrismaClient } from '../../../prisma-historical/generated/client';
import { prismaHistoricalAggregate } from '../../core/prisma.historical.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { planRollupWindow, rollupKeepDays, firstKeptDay } from './elysium-rollup.util';
import type { RollupDayCoverage, RollupPlan } from './elysium-rollup.util';

/**
 * Read side of the Elysium day rollups: which days are built, and the SQL
 * pieces a query needs to read a window as "built days from the rollups, the
 * rest from elysium_tx".
 */

/** ELYSIUM_ROLLUPS_ENABLED=false: nothing is built and nothing is read from the rollups. */
export function rollupsEnabled(): boolean {
  return (process.env.ELYSIUM_ROLLUPS_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

/** The list of built days could not be read: the computation that needed it is given up. */
export class RollupCoverageUnreadableError extends Error {
  constructor() {
    super('ELYSIUM_ROLLUP_COVERAGE_UNREADABLE');
    this.name = 'RollupCoverageUnreadableError';
  }
}

/**
 * The built, non-dirty days. Read at the start of every computation, never
 * cached: a day marked dirty stops being used by the next one.
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
): Promise<Map<string, RollupDayCoverage>> {
  const coverage = new Map<string, RollupDayCoverage>();
  if (!rollupsEnabled()) return coverage;
  try {
    const rows = await (options.db ?? prismaHistoricalAggregate).$queryRaw<Array<{ day: string; callers_built: boolean; senders_built: boolean }>>`
      SELECT day::text AS day, callers_built, senders_built FROM elysium_day_rollup
      WHERE built_at IS NOT NULL AND NOT dirty AND day >= ${firstKeptDay(now, rollupKeepDays())}::date`;
    for (const r of rows) coverage.set(r.day.slice(0, 10), { callers: r.callers_built, senders: r.senders_built });
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
  }
  return coverage;
}

/** `day = ANY(...)` operand: the plan's rollup days as a date array. */
export function rollupDays(plan: RollupPlan): Prisma.Sql {
  return Prisma.sql`${plan.days}::text[]::date[]`;
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
  coverage: ReadonlyMap<string, RollupDayCoverage>,
  db: PrismaClient = prismaHistoricalAggregate
): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();
  const plan = planRollupWindow(start, end, coverage, 'callers');
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

  const rows = await db.$queryRaw<Array<{ address: string; callers: number }>>`
    SELECT address, count(DISTINCT from_addr)::int AS callers FROM (
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
    ) u GROUP BY address`;
  return new Map(rows.map((r) => [r.address, r.callers]));
}

export { planRollupWindow };
export type { RollupDayCoverage, RollupPlan };
