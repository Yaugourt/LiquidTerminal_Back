import { Prisma } from '../../../prisma-historical/generated/client';
import { prismaHistoricalAggregate } from '../../core/prisma.historical.service';
import { PRECOMPILE_LIKE } from './elysium-analytics.util';
import { rawRanges, rollupDays, rollupHours, withWorkMem } from './elysium-rollup.reader';
import type { RollupPlan } from './elysium-rollup.util';
import type { WindowDelta, WindowState } from './elysium-window.util';

/**
 * Reads of the Elysium window tables (elysium_target_window): the statements
 * of the fees and contracts views when a table can be used.
 *
 * A statement reads, in one snapshot: the table (sums per called address over
 * the days and hours its state lists), and the delta, what the reader's own
 * window holds that the table does not, or the reverse: a few hours of the
 * hour rollups, a day of the day rollups at most, signed, and the raw ranges
 * of the plan (about two hours of elysium_tx). The addresses of the delta get
 * their class from the contract and token tables as they are now, and their
 * row of the table by its key; every other address is read from the table's
 * indexes and totals, with the class the table holds for it (looked at again
 * by the builder on each of its passes).
 *
 * Each statement also returns a guard: the table's version and whether the
 * rollups it takes off are still the ones the table was read from. A reader
 * that planned with another version, or finds one of them rebuilt, got sums
 * that do not belong together: it drops them and plans again.
 */

const agg = prismaHistoricalAggregate;

const texts = (values: Array<string | number>): string[] => values.map((v) => String(v));
const isoHours = (hours: number[]): string[] => hours.map((h) => new Date(h).toISOString());

/** The guard's columns: the table's version, and how many of the rollups taken off are the ones the table was read from. */
function guardSql(span: number, delta: WindowDelta): Prisma.Sql {
  return Prisma.sql`
    SELECT (SELECT version::text FROM elysium_window_state WHERE span = ${span}::smallint) AS version,
           (SELECT count(*) FROM unnest(${delta.subDays.map((d) => d.day)}::text[]::date[], ${texts(delta.subDays.map((d) => d.at))}::text[]::bigint[]) AS u(day, at)
             JOIN elysium_day_rollup r ON r.day = u.day
             WHERE r.built_at IS NOT NULL AND round(extract(epoch FROM r.built_at) * 1000)::bigint = u.at)::int AS days,
           (SELECT count(*) FROM unnest(${isoHours(delta.subHours.map((h) => h.hour))}::text[]::timestamptz[], ${texts(delta.subHours.map((h) => h.at))}::text[]::bigint[]) AS u(hour, at)
             JOIN elysium_hour_rollup r ON r.hour = u.hour
             WHERE r.built_at IS NOT NULL AND round(extract(epoch FROM r.built_at) * 1000)::bigint = u.at)::int AS hours`;
}

/**
 * The delta per called address, signed: `rawRows` (address, fee, txs, gas of the plan's raw
 * ranges), plus the days and hours the table lacks, minus the ones the plan lacks.
 */
function deltaSql(rawRows: Prisma.Sql, delta: WindowDelta): Prisma.Sql {
  return Prisma.sql`
    SELECT address, sum(fee) AS fee, sum(txs)::bigint AS txs, sum(gas) AS gas FROM (
      ${rawRows}
      UNION ALL
      SELECT d.to_addr, d.fee_wei, d.txs::bigint, d.gas_used::numeric
      FROM elysium_call_day d WHERE d.day = ANY(${delta.addDays}::text[]::date[])
      UNION ALL
      SELECT d.to_addr, -d.fee_wei, -d.txs::bigint, -d.gas_used::numeric
      FROM elysium_call_day d WHERE d.day = ANY(${delta.subDays.map((d) => d.day)}::text[]::date[])
      UNION ALL
      SELECT h.to_addr, h.fee_wei, h.txs::bigint, h.gas_used::numeric
      FROM elysium_call_hour h WHERE h.hour = ANY(${isoHours(delta.addHours)}::text[]::timestamptz[])
      UNION ALL
      SELECT h.to_addr, -h.fee_wei, -h.txs::bigint, -h.gas_used::numeric
      FROM elysium_call_hour h WHERE h.hour = ANY(${isoHours(delta.subHours.map((h) => h.hour))}::text[]::timestamptz[])
    ) u GROUP BY address
    HAVING sum(txs) <> 0 OR sum(fee) <> 0 OR sum(gas) <> 0`;
}

/** Each address of the delta (CTE `e`) with its class as of now and its row of the table. */
function classedSql(span: number): Prisma.Sql {
  return Prisma.sql`
    SELECT e.address, e.fee, e.txs, e.gas, c.deployer,
           CASE WHEN e.address LIKE ${PRECOMPILE_LIKE} THEN 2
                WHEN c.address IS NOT NULL OR tk.address IS NOT NULL THEN 1 ELSE 0 END AS kind,
           w.txs AS w_txs, w.fee_wei AS w_fee, w.gas_used AS w_gas, w.kind AS w_kind, w.deployer AS w_deployer
    FROM e
    LEFT JOIN elysium_contract c ON c.address = e.address
    LEFT JOIN elysium_token tk ON tk.address = e.address
    LEFT JOIN elysium_target_window w ON w.span = ${span}::smallint AND w.to_addr = e.address`;
}

function guardHolds(guard: { version: string | null; days: number; hours: number } | undefined, state: WindowState, delta: WindowDelta): boolean {
  return guard !== undefined && guard.version === state.version && guard.days === delta.subDays.length && guard.hours === delta.subHours.length;
}

export interface FeeRow {
  kind: string;
  key: string | null;
  fees: number;
  txs: number;
  gas: string | null;
  n: number;
}

/**
 * The rows of the fees view (total, all, apps, system, top 25 contracts, top 15 deployers), the
 * same as the statement that reads the rollups alone gives. Null when the guard does not hold.
 */
export async function feesFromWindow(state: WindowState, plan: RollupPlan, delta: WindowDelta): Promise<FeeRow[] | null> {
  const span = state.span;
  // With memory for the hash of the delta's addresses: the table's own top 25 is read past them.
  const rows = await withWorkMem(agg, (tx) => tx.$queryRaw<FeeRow[]>`
    WITH st AS (
      SELECT * FROM elysium_window_state WHERE span = ${span}::smallint
    ),
    guard AS (${guardSql(span, delta)}),
    raw AS MATERIALIZED (
      -- The raw part of the window, read once: per target for the non-spam transactions sent
      -- to an address, and one row (address NULL) for the rest, contract creations and spam.
      SELECT CASE WHEN NOT t.is_spam THEN t.to_addr END AS address,
             sum(t.fee_wei) AS fee, count(*)::bigint AS txs, sum(t.gas_used) AS gas
      FROM elysium_tx t
      WHERE ${rawRanges(Prisma.sql`t.block_time`, plan)}
      GROUP BY 1
    ),
    e AS MATERIALIZED (${deltaSql(Prisma.sql`SELECT address, fee, txs, gas FROM raw WHERE address IS NOT NULL`, delta)}),
    ec AS MATERIALIZED (${classedSql(span)}),
    tot AS (
      -- What the delta moves in each class: its own sums under the class of now, and the
      -- table's sums for an address the table holds under another class.
      SELECT COALESCE(sum(fee), 0) AS e_fee, COALESCE(sum(txs), 0) AS e_txs, COALESCE(sum(gas), 0) AS e_gas,
             COALESCE(sum(fee + CASE WHEN w_kind IS DISTINCT FROM 1 THEN COALESCE(w_fee, 0) ELSE 0 END) FILTER (WHERE kind = 1), 0)
               - COALESCE(sum(w_fee) FILTER (WHERE w_kind = 1 AND kind <> 1), 0) AS a_fee,
             COALESCE(sum(txs + CASE WHEN w_kind IS DISTINCT FROM 1 THEN COALESCE(w_txs, 0) ELSE 0 END) FILTER (WHERE kind = 1), 0)
               - COALESCE(sum(w_txs) FILTER (WHERE w_kind = 1 AND kind <> 1), 0) AS a_txs,
             COALESCE(sum(gas + CASE WHEN w_kind IS DISTINCT FROM 1 THEN COALESCE(w_gas, 0) ELSE 0 END) FILTER (WHERE kind = 1), 0)
               - COALESCE(sum(w_gas) FILTER (WHERE w_kind = 1 AND kind <> 1), 0) AS a_gas,
             COALESCE(sum((CASE WHEN COALESCE(w_txs, 0) + txs > 0 THEN 1 ELSE 0 END)
                          - (CASE WHEN w_kind = 1 AND w_txs > 0 THEN 1 ELSE 0 END)) FILTER (WHERE kind = 1), 0)
               - count(*) FILTER (WHERE w_kind = 1 AND kind <> 1 AND w_txs > 0) AS a_n,
             COALESCE(sum(fee + CASE WHEN w_kind IS DISTINCT FROM 2 THEN COALESCE(w_fee, 0) ELSE 0 END) FILTER (WHERE kind = 2), 0)
               - COALESCE(sum(w_fee) FILTER (WHERE w_kind = 2 AND kind <> 2), 0) AS s_fee,
             COALESCE(sum(txs + CASE WHEN w_kind IS DISTINCT FROM 2 THEN COALESCE(w_txs, 0) ELSE 0 END) FILTER (WHERE kind = 2), 0)
               - COALESCE(sum(w_txs) FILTER (WHERE w_kind = 2 AND kind <> 2), 0) AS s_txs,
             COALESCE(sum(gas + CASE WHEN w_kind IS DISTINCT FROM 2 THEN COALESCE(w_gas, 0) ELSE 0 END) FILTER (WHERE kind = 2), 0)
               - COALESCE(sum(w_gas) FILTER (WHERE w_kind = 2 AND kind <> 2), 0) AS s_gas,
             COALESCE(sum((CASE WHEN COALESCE(w_txs, 0) + txs > 0 THEN 1 ELSE 0 END)
                          - (CASE WHEN w_kind = 2 AND w_txs > 0 THEN 1 ELSE 0 END)) FILTER (WHERE kind = 2), 0)
               - count(*) FILTER (WHERE w_kind = 2 AND kind <> 2 AND w_txs > 0) AS s_n
      FROM ec
    ),
    cand AS (
      -- The known addresses of the delta with the table's part, and the table's own top 25
      -- among the others: no address outside the two can be in the top 25.
      SELECT address, COALESCE(w_fee, 0) + fee AS fee, COALESCE(w_txs, 0) + txs AS txs, COALESCE(w_gas, 0) + gas AS gas
      FROM ec WHERE kind > 0
      UNION ALL
      (SELECT w.to_addr, w.fee_wei, w.txs::bigint, w.gas_used::numeric
       FROM elysium_target_window w
       WHERE w.span = ${span}::smallint AND w.kind > 0 AND w.txs > 0
         AND w.to_addr NOT IN (SELECT address FROM e)
       ORDER BY w.fee_wei DESC, w.to_addr LIMIT 25)
    ),
    ed AS (
      -- The delta per deployer: under the deployer of now, the delta's sums and, when the
      -- table holds the address under another deployer or none, the table's part with them;
      -- and that part taken off the deployer the table had it under.
      SELECT deployer, sum(fee) AS fee, sum(txs) AS txs, sum(gas) AS gas, sum(n)::int AS n FROM (
        SELECT deployer,
               fee + CASE WHEN w_deployer IS DISTINCT FROM deployer THEN COALESCE(w_fee, 0) ELSE 0 END AS fee,
               txs + CASE WHEN w_deployer IS DISTINCT FROM deployer THEN COALESCE(w_txs, 0) ELSE 0 END AS txs,
               gas + CASE WHEN w_deployer IS DISTINCT FROM deployer THEN COALESCE(w_gas, 0) ELSE 0 END AS gas,
               (CASE WHEN COALESCE(w_txs, 0) + txs > 0 THEN 1 ELSE 0 END)
                 - (CASE WHEN w_deployer IS NOT DISTINCT FROM deployer AND w_txs > 0 THEN 1 ELSE 0 END) AS n
        FROM ec WHERE deployer IS NOT NULL
        UNION ALL
        SELECT w_deployer, -w_fee, -w_txs::bigint, -w_gas::numeric, -(CASE WHEN w_txs > 0 THEN 1 ELSE 0 END)
        FROM ec WHERE w_deployer IS NOT NULL AND w_deployer IS DISTINCT FROM deployer
      ) x GROUP BY deployer
    ),
    dcand AS (
      SELECT ed.deployer, COALESCE(wd.fee_wei, 0) + ed.fee AS fee, COALESCE(wd.txs, 0) + ed.txs AS txs,
             COALESCE(wd.gas_used, 0) + ed.gas AS gas, COALESCE(wd.contracts, 0) + ed.n AS n
      FROM ed
      LEFT JOIN elysium_deployer_window wd ON wd.span = ${span}::smallint AND wd.deployer = ed.deployer
      UNION ALL
      (SELECT wd.deployer, wd.fee_wei, wd.txs, wd.gas_used, wd.contracts
       FROM elysium_deployer_window wd
       WHERE wd.span = ${span}::smallint AND wd.deployer NOT IN (SELECT deployer FROM ed)
       ORDER BY wd.fee_wei DESC, wd.deployer LIMIT 15)
    )
    SELECT 'guard' AS kind, guard.version AS key, 0::float8 AS fees, guard.days AS txs, NULL::text AS gas, guard.hours AS n FROM guard
    UNION ALL
    SELECT 'total', NULL, ((st.other_fee_wei + st.app_fee_wei + st.system_fee_wei + tot.e_fee) / 1e18)::float8,
           (st.other_txs + st.app_txs + st.system_txs + tot.e_txs)::int,
           (st.other_gas_used + st.app_gas_used + st.system_gas_used + tot.e_gas)::text, 0
    FROM st, tot
    UNION ALL
    -- Every transaction of the window, as the economics page counts them: the totals of the
    -- rollup days and hours and the whole of the raw part.
    SELECT 'all', NULL,
           ((COALESCE((SELECT sum(r.fee_wei) FROM elysium_day_rollup r WHERE r.day = ANY(${rollupDays(plan)})), 0)
             + COALESCE((SELECT sum(h.fee_wei) FROM elysium_hour_rollup h WHERE h.hour = ANY(${rollupHours(plan)})), 0)
             + COALESCE((SELECT sum(fee) FROM raw), 0)) / 1e18)::float8,
           (COALESCE((SELECT sum(r.txs + r.spam_txs) FROM elysium_day_rollup r WHERE r.day = ANY(${rollupDays(plan)})), 0)
             + COALESCE((SELECT sum(h.txs + h.spam_txs) FROM elysium_hour_rollup h WHERE h.hour = ANY(${rollupHours(plan)})), 0)
             + COALESCE((SELECT sum(txs) FROM raw), 0))::int,
           NULL, 1
    UNION ALL
    SELECT 'apps', NULL, ((st.app_fee_wei + tot.a_fee) / 1e18)::float8, (st.app_txs + tot.a_txs)::int,
           (st.app_gas_used + tot.a_gas)::text, (st.app_n + tot.a_n)::int
    FROM st, tot
    UNION ALL
    SELECT 'system', NULL, ((st.system_fee_wei + tot.s_fee) / 1e18)::float8, (st.system_txs + tot.s_txs)::int,
           (st.system_gas_used + tot.s_gas)::text, (st.system_n + tot.s_n)::int
    FROM st, tot
    UNION ALL
    (SELECT 'contract', address, (fee / 1e18)::float8, txs::int, gas::text, 1 FROM cand WHERE txs > 0 ORDER BY fee DESC, address LIMIT 25)
    UNION ALL
    (SELECT 'deployer', deployer, (fee / 1e18)::float8, txs::int, gas::text, n::int FROM dcand WHERE n > 0 ORDER BY fee DESC, deployer LIMIT 15)`);

  const guard = rows.find((r) => r.kind === 'guard');
  if (!guardHolds(guard ? { version: guard.key, days: guard.txs, hours: guard.n } : undefined, state, delta)) return null;
  return rows.filter((r) => r.kind !== 'guard');
}

export interface TopContractRow {
  address: string;
  txs: number;
  gas_used: string;
}

/**
 * The 25 known contracts with the most non-spam transactions over the window, the same as the
 * statement that reads the rollups alone gives. Null when the guard does not hold.
 */
export async function topContractsFromWindow(state: WindowState, plan: RollupPlan, delta: WindowDelta): Promise<TopContractRow[] | null> {
  const span = state.span;
  const rows = await withWorkMem(agg, (tx) => tx.$queryRaw<Array<{ kind: string; address: string | null; txs: number; gas_used: string | null; n: number }>>`
    WITH guard AS (${guardSql(span, delta)}),
    e AS MATERIALIZED (${deltaSql(
      Prisma.sql`SELECT t.to_addr AS address, 0::numeric AS fee, count(*)::bigint AS txs, sum(t.gas_used) AS gas
                 FROM elysium_tx t
                 WHERE ${rawRanges(Prisma.sql`t.block_time`, plan)} AND NOT t.is_spam AND t.to_addr IS NOT NULL
                 GROUP BY t.to_addr`,
      delta
    )}),
    ec AS MATERIALIZED (${classedSql(span)}),
    cand AS (
      SELECT address, COALESCE(w_txs, 0) + txs AS txs, COALESCE(w_gas, 0) + gas AS gas
      FROM ec WHERE kind > 0
      UNION ALL
      (SELECT w.to_addr, w.txs::bigint, w.gas_used::numeric
       FROM elysium_target_window w
       WHERE w.span = ${span}::smallint AND w.kind > 0 AND w.txs > 0
         AND w.to_addr NOT IN (SELECT address FROM e)
       ORDER BY w.txs DESC, w.to_addr LIMIT 25)
    )
    SELECT 'guard' AS kind, guard.version AS address, guard.days AS txs, NULL::text AS gas_used, guard.hours AS n FROM guard
    UNION ALL
    (SELECT 'contract', address, txs::int, gas::text, 0 FROM cand WHERE txs > 0 ORDER BY txs DESC, address LIMIT 25)`);

  const guard = rows.find((r) => r.kind === 'guard');
  if (!guardHolds(guard ? { version: guard.address, days: guard.txs, hours: guard.n } : undefined, state, delta)) return null;
  return rows
    .filter((r) => r.kind === 'contract' && r.address !== null)
    .map((r) => ({ address: r.address as string, txs: r.txs, gas_used: r.gas_used ?? '0' }));
}
