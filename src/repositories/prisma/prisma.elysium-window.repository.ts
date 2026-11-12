import { prismaHistorical } from '../../core/prisma.historical.service';
import { PRECOMPILE_LIKE } from '../../services/elysium/elysium-analytics.util';
import { WINDOW_SPANS } from '../../services/elysium/elysium-rollup.util';
import type { WindowDay, WindowHour, WindowState } from '../../services/elysium/elysium-window.util';
import { BUILD_LOCK_KEY } from './prisma.elysium-rollup.repository';

/** Time limit of one refresh: the widest base reads 29 days of elysium_call_day once. */
const REFRESH_TIMEOUT_MS = 900_000;

/** Constant SQL (no user input): an address's class from the joined contract (c) and token (k) rows. */
const KIND_SQL = (addr: string): string =>
  `CASE WHEN ${addr} LIKE '${PRECOMPILE_LIKE}' THEN 2 WHEN c.address IS NOT NULL OR k.address IS NOT NULL THEN 1 ELSE 0 END`;

export type WindowRefreshResult =
  /** The table stands for the target. */
  | 'refreshed'
  /** A rollup of the target, or of the base, is not the one the caller read: nothing was changed. */
  | 'stale'
  /** A build holds the lock. */
  | 'busy';

class WindowBusyError extends Error {}
class WindowStaleError extends Error {}
/** The rows do not add up (a sum under zero): the table is marked not ready and worked out again from nothing. */
export class WindowInconsistentError extends Error {
  constructor(span: number) {
    super(`ELYSIUM_WINDOW_INCONSISTENT span=${span}`);
    this.name = 'WindowInconsistentError';
  }
}

type Tx = Parameters<Parameters<typeof prismaHistorical.$transaction>[0]>[0];

interface StateRow {
  span: number;
  version: string;
  ready: boolean;
  epoch: string;
  base_days: unknown;
  cover_days: unknown;
  cover_hours: unknown;
  refreshed_ms: number | null;
}

function days(value: unknown): WindowDay[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is { day: string; at: number } => typeof v?.day === 'string' && Number.isFinite(Number(v?.at)))
    .map((v) => ({ day: v.day.slice(0, 10), at: Number(v.at) }));
}

function hours(value: unknown): WindowHour[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is { hour: number; at: number } => Number.isFinite(Number(v?.hour)) && Number.isFinite(Number(v?.at)))
    .map((v) => ({ hour: Number(v.hour), at: Number(v.at) }));
}

export function toWindowState(row: StateRow): WindowState {
  return {
    span: Number(row.span),
    version: String(row.version),
    ready: row.ready,
    epoch: String(row.epoch),
    baseDays: days(row.base_days),
    coverDays: days(row.cover_days),
    coverHours: hours(row.cover_hours),
    refreshedAt: row.refreshed_ms === null || row.refreshed_ms === undefined ? null : Math.round(Number(row.refreshed_ms)),
  };
}

/** The columns of a state row a reader or the builder needs, as SQL. */
export const WINDOW_STATE_COLUMNS = `span, version::text AS version, ready, epoch::text AS epoch, base_days, cover_days, cover_hours,
  (extract(epoch FROM refreshed_at) * 1000)::float8 AS refreshed_ms`;

/**
 * Write side of the Elysium window tables (historical DB): elysium_target_window, its sums per
 * deployer and its state row, per span.
 *
 * Every change is one transaction under the rollup builders' lock, so that no day or hour is
 * rebuilt while a table is computed from it, and readers see the table before or after, never
 * in between. Nothing is ever adjusted by what changed: the base columns are the sums of the
 * base days as elysium_call_day holds them now, the totals are base + edges as recomputed now,
 * and the totals per class and per deployer are sums over the table's rows. A table that
 * drifted would stay wrong; one that is recomputed cannot.
 */
export class ElysiumWindowRepository {
  private static instance: ElysiumWindowRepository;

  public static getInstance(): ElysiumWindowRepository {
    if (!ElysiumWindowRepository.instance) {
      ElysiumWindowRepository.instance = new ElysiumWindowRepository();
    }
    return ElysiumWindowRepository.instance;
  }

  /** The state of every window, and the removal counter (row span = 0). */
  public async readStates(): Promise<{ epoch: string; states: Map<number, WindowState> }> {
    const rows = await prismaHistorical.$queryRawUnsafe<StateRow[]>(`SELECT ${WINDOW_STATE_COLUMNS} FROM elysium_window_state`);
    const states = new Map<number, WindowState>();
    let epoch = '0';
    for (const row of rows) {
      if (Number(row.span) === 0) epoch = String(row.version);
      else states.set(Number(row.span), toWindowState(row));
    }
    return { epoch, states };
  }

  /** Marks a table not ready: readers leave it, and the next refresh works it out from nothing. */
  public async markNotReady(span: number): Promise<void> {
    await prismaHistorical.$executeRawUnsafe(
      `UPDATE elysium_window_state SET ready = false, version = version + 1 WHERE span = $1::smallint`,
      span
    );
  }

  /**
   * Brings the table of `span` to `target`: its days and hours, each with the build time of
   * the rollup the caller saw.
   *
   * - `rebase`: the base columns are recomputed from the target's days. Otherwise the base
   *   stays, and the days that differ go to the edges: a target day the base lacks is added
   *   there, a base day the target lacks is taken off.
   * - The table is worked out from nothing (every row deleted and written again, classes
   *   included) when it is not ready, or when a contract was removed since its classes were
   *   last worked out from nothing.
   *
   * Stale when a rollup is not the one the caller read (rebuilt, dropped, or not built):
   * nothing is changed, and the caller plans again.
   */
  public async refresh(
    span: number,
    target: { days: WindowDay[]; hours: WindowHour[] },
    opts: { rebase: boolean }
  ): Promise<WindowRefreshResult> {
    if (!(WINDOW_SPANS as readonly number[]).includes(span)) throw new Error(`Invalid window span: ${span}`);
    try {
      await prismaHistorical.$transaction(
        async (tx) => {
          const lock = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
            `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
            BUILD_LOCK_KEY
          );
          if (!lock[0]?.ok) throw new WindowBusyError();
          await tx.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`);
          await tx.$executeRawUnsafe(`SET LOCAL work_mem = '128MB'`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REFRESH_TIMEOUT_MS}`);

          await tx.$executeRawUnsafe(
            `INSERT INTO elysium_window_state (span) VALUES ($1::smallint) ON CONFLICT (span) DO NOTHING`,
            span
          );
          // The removal counter first: a contract removed after this read leaves the table's
          // epoch behind it, and the table is worked out again.
          const counter = await tx.$queryRawUnsafe<Array<{ version: string }>>(
            `SELECT version::text AS version FROM elysium_window_state WHERE span = 0`
          );
          const epoch = counter[0]?.version ?? '0';
          const rows = await tx.$queryRawUnsafe<StateRow[]>(
            `SELECT ${WINDOW_STATE_COLUMNS} FROM elysium_window_state WHERE span = $1::smallint FOR UPDATE`,
            span
          );
          const state = toWindowState(rows[0]);
          const full = !state.ready || state.epoch !== epoch;
          const rebase = full || opts.rebase;
          const baseDays = rebase ? target.days : state.baseDays;
          // A base that stays must be the sums of the days as the target names them: a day kept
          // in both with another build time was rebuilt since the base was summed. The builder
          // asks for a rebase then (windowWork); a caller that does not gets nothing changed.
          const targetAt = new Map(target.days.map((d) => [d.day, d.at]));
          if (!rebase && state.baseDays.some((d) => targetAt.has(d.day) && targetAt.get(d.day) !== d.at)) throw new WindowStaleError();
          const targetDays = new Set(target.days.map((d) => d.day));
          const baseSet = new Set(baseDays.map((d) => d.day));
          const addDays = target.days.filter((d) => !baseSet.has(d.day));
          const subDays = baseDays.filter((d) => !targetDays.has(d.day));

          // Every rollup this refresh reads must be the one the caller saw. No build runs
          // meanwhile (the lock), so what is checked here holds to the end.
          const checkDays = [...target.days, ...subDays];
          const ok = await tx.$queryRawUnsafe<Array<{ days: number; hours: number }>>(
            `SELECT
               (SELECT count(*) FROM unnest($1::text[]::date[], $2::text[]::bigint[]) AS u(day, at)
                 JOIN elysium_day_rollup r ON r.day = u.day
                 WHERE r.built_at IS NOT NULL AND round(extract(epoch FROM r.built_at) * 1000)::bigint = u.at)::int AS days,
               (SELECT count(*) FROM unnest($3::text[]::timestamptz[], $4::text[]::bigint[]) AS u(hour, at)
                 JOIN elysium_hour_rollup r ON r.hour = u.hour
                 WHERE r.built_at IS NOT NULL AND round(extract(epoch FROM r.built_at) * 1000)::bigint = u.at)::int AS hours`,
            checkDays.map((d) => d.day),
            checkDays.map((d) => String(d.at)),
            target.hours.map((h) => new Date(h.hour).toISOString()),
            target.hours.map((h) => String(h.at))
          );
          if (ok[0]?.days !== checkDays.length || ok[0]?.hours !== target.hours.length) throw new WindowStaleError();

          if (full) await this.writeFromNothing(tx, span, baseDays);
          else if (rebase) await this.rebase(tx, span, baseDays);
          // The statements that follow join the table by address: they are planned on what it holds now.
          if (rebase) await tx.$executeRawUnsafe(`ANALYZE elysium_target_window_${span}`);
          await this.refreshEdges(tx, span, {
            hours: target.hours.map((h) => new Date(h.hour).toISOString()),
            addDays: addDays.map((d) => d.day),
            subDays: subDays.map((d) => d.day),
          });
          if (!full) await this.classify(tx, [span]);

          const negative = await tx.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM elysium_target_window
             WHERE span = $1::smallint AND (txs < 0 OR fee_wei < 0 OR gas_used < 0 OR d_txs < 0 OR d_fee_wei < 0 OR d_gas_used < 0)`,
            span
          );
          if ((negative[0]?.n ?? 0) > 0) throw new WindowInconsistentError(span);

          await this.writeTotals(tx, span);
          await tx.$executeRawUnsafe(
            `UPDATE elysium_window_state SET
               version = version + 1, ready = true, epoch = $2::bigint,
               base_days = $3::jsonb, cover_days = $4::jsonb, cover_hours = $5::jsonb,
               based_at = CASE WHEN $6::boolean THEN now() ELSE based_at END,
               refreshed_at = now(), classified_at = now()
             WHERE span = $1::smallint`,
            span,
            full ? epoch : state.epoch,
            JSON.stringify(baseDays),
            JSON.stringify(target.days),
            JSON.stringify(target.hours),
            rebase
          );
        },
        { timeout: REFRESH_TIMEOUT_MS + 30_000, maxWait: 20_000 }
      );
    } catch (error) {
      if (error instanceof WindowBusyError) return 'busy';
      if (error instanceof WindowStaleError) return 'stale';
      if (error instanceof WindowInconsistentError) {
        await this.markNotReady(span);
        return 'stale';
      }
      throw error;
    }
    return 'refreshed';
  }

  /**
   * Looks again, in every table that is ready, at the rows whose class may have changed since
   * they were written: an address that was no known contract and is one now (a token entered
   * in the registry hours after its first calls, a contract deployed at an address that had
   * already received transactions), and a known one whose deployer is now known. One pass for
   * all the spans: it reads the contract table once. Returns how many rows changed per span;
   * a table's totals follow when one of its rows did. A contract that is removed is not seen
   * from here: see the removal counter.
   */
  public async reclassify(): Promise<Map<number, number> | 'busy'> {
    try {
      return await prismaHistorical.$transaction(
        async (tx) => {
          const lock = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
            `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
            BUILD_LOCK_KEY
          );
          if (!lock[0]?.ok) throw new WindowBusyError();
          const ready = await tx.$queryRawUnsafe<Array<{ span: number }>>(
            `SELECT span FROM elysium_window_state WHERE span > 0 AND ready ORDER BY span FOR UPDATE`
          );
          const spans = ready.map((r) => Number(r.span));
          const changed = new Map<number, number>();
          if (spans.length === 0) return changed;
          await tx.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`);
          await tx.$executeRawUnsafe(`SET LOCAL work_mem = '128MB'`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REFRESH_TIMEOUT_MS}`);
          const rows = await this.classify(tx, spans);
          for (const row of rows) changed.set(Number(row.span), (changed.get(Number(row.span)) ?? 0) + Number(row.n));
          for (const span of changed.keys()) await this.writeTotals(tx, span);
          await tx.$executeRawUnsafe(
            `UPDATE elysium_window_state SET
               classified_at = now(),
               version = version + CASE WHEN span = ANY($2::smallint[]) THEN 1 ELSE 0 END
             WHERE span = ANY($1::smallint[])`,
            spans,
            [...changed.keys()]
          );
          return changed;
        },
        { timeout: REFRESH_TIMEOUT_MS + 30_000, maxWait: 20_000 }
      );
    } catch (error) {
      if (error instanceof WindowBusyError) return 'busy';
      throw error;
    }
  }

  /** Every row of the span deleted, and the base written again from its days with each address's class as of now. */
  private async writeFromNothing(tx: Tx, span: number, baseDays: WindowDay[]): Promise<void> {
    await tx.$executeRawUnsafe(`DELETE FROM elysium_target_window WHERE span = $1::smallint`, span);
    await tx.$executeRawUnsafe(
      `INSERT INTO elysium_target_window
         (span, to_addr, d_txs, d_fee_wei, d_gas_used, txs, fee_wei, gas_used, edged, kind, deployer)
       SELECT $1::smallint, f.to_addr, f.txs, f.fee, f.gas, f.txs, f.fee, f.gas, false, ${KIND_SQL('f.to_addr')}, c.deployer
       FROM (
         SELECT to_addr, sum(txs)::int AS txs, sum(fee_wei) AS fee, sum(gas_used)::bigint AS gas
         FROM elysium_call_day WHERE day = ANY($2::text[]::date[])
         GROUP BY to_addr
       ) f
       LEFT JOIN elysium_contract c ON c.address = f.to_addr
       LEFT JOIN elysium_token k ON k.address = f.to_addr`,
      span,
      baseDays.map((d) => d.day)
    );
  }

  /**
   * The base columns brought to the sums of `baseDays`, writing only the rows that differ: the
   * addresses of the day that left the window and of the day that entered it, not the whole
   * table. A row's edges are kept as they are (the refresh of the edges that follows recomputes
   * them); a row without edges takes the new base as its totals.
   */
  private async rebase(tx: Tx, span: number, baseDays: WindowDay[]): Promise<void> {
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE _elysium_window_base (to_addr text PRIMARY KEY, txs int, fee numeric, gas bigint) ON COMMIT DROP`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO _elysium_window_base
       SELECT to_addr, sum(txs)::int, sum(fee_wei), sum(gas_used)::bigint
       FROM elysium_call_day WHERE day = ANY($1::text[]::date[])
       GROUP BY to_addr`,
      baseDays.map((d) => d.day)
    );
    await tx.$executeRawUnsafe(`ANALYZE _elysium_window_base`);
    // Rows whose base changed.
    await tx.$executeRawUnsafe(
      `UPDATE elysium_target_window w SET
         d_txs = b.txs, d_fee_wei = b.fee, d_gas_used = b.gas,
         txs = CASE WHEN w.edged THEN w.txs - w.d_txs + b.txs ELSE b.txs END,
         fee_wei = CASE WHEN w.edged THEN w.fee_wei - w.d_fee_wei + b.fee ELSE b.fee END,
         gas_used = CASE WHEN w.edged THEN w.gas_used - w.d_gas_used + b.gas ELSE b.gas END
       FROM _elysium_window_base b
       WHERE w.span = $1::smallint AND w.to_addr = b.to_addr
         AND (w.d_txs, w.d_fee_wei, w.d_gas_used) IS DISTINCT FROM (b.txs, b.fee, b.gas)`,
      span
    );
    // Rows that left the base: gone when they have no edge, back to their edge alone otherwise.
    await tx.$executeRawUnsafe(
      `DELETE FROM elysium_target_window w
       WHERE w.span = $1::smallint AND NOT w.edged
         AND NOT EXISTS (SELECT 1 FROM _elysium_window_base b WHERE b.to_addr = w.to_addr)`,
      span
    );
    await tx.$executeRawUnsafe(
      `UPDATE elysium_target_window w SET
         txs = w.txs - w.d_txs, fee_wei = w.fee_wei - w.d_fee_wei, gas_used = w.gas_used - w.d_gas_used,
         d_txs = 0, d_fee_wei = 0, d_gas_used = 0
       WHERE w.span = $1::smallint AND w.edged AND (w.d_txs <> 0 OR w.d_fee_wei <> 0 OR w.d_gas_used <> 0)
         AND NOT EXISTS (SELECT 1 FROM _elysium_window_base b WHERE b.to_addr = w.to_addr)`,
      span
    );
    // Addresses new to the table, with their class as of now.
    await tx.$executeRawUnsafe(
      `INSERT INTO elysium_target_window
         (span, to_addr, d_txs, d_fee_wei, d_gas_used, txs, fee_wei, gas_used, edged, kind, deployer)
       SELECT $1::smallint, b.to_addr, b.txs, b.fee, b.gas, b.txs, b.fee, b.gas, false, ${KIND_SQL('b.to_addr')}, c.deployer
       FROM _elysium_window_base b
       LEFT JOIN elysium_contract c ON c.address = b.to_addr
       LEFT JOIN elysium_token k ON k.address = b.to_addr
       WHERE NOT EXISTS (SELECT 1 FROM elysium_target_window w WHERE w.span = $1::smallint AND w.to_addr = b.to_addr)`,
      span
    );
  }

  /**
   * The edges recomputed: the target's hours, plus the days added to the base, minus the days
   * taken off it. Every row that has an edge, or had one, gets totals = base + edge; only the
   * rows whose totals change are written.
   */
  private async refreshEdges(tx: Tx, span: number, edge: { hours: string[]; addDays: string[]; subDays: string[] }): Promise<void> {
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE _elysium_window_edge (to_addr text PRIMARY KEY, txs int, fee numeric, gas bigint) ON COMMIT DROP`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO _elysium_window_edge
       SELECT to_addr, sum(txs)::int, sum(fee), sum(gas)::bigint FROM (
         SELECT to_addr, txs, fee_wei AS fee, gas_used AS gas FROM elysium_call_hour WHERE hour = ANY($1::text[]::timestamptz[])
         UNION ALL
         SELECT to_addr, txs, fee_wei, gas_used FROM elysium_call_day WHERE day = ANY($2::text[]::date[])
         UNION ALL
         SELECT to_addr, -txs, -fee_wei, -gas_used FROM elysium_call_day WHERE day = ANY($3::text[]::date[])
       ) u GROUP BY to_addr
       HAVING sum(txs) <> 0 OR sum(fee) <> 0 OR sum(gas) <> 0`,
      edge.hours,
      edge.addDays,
      edge.subDays
    );
    await tx.$executeRawUnsafe(`ANALYZE _elysium_window_edge`);
    // Rows that had an edge and have none now: gone when they have no base, back to their base otherwise.
    await tx.$executeRawUnsafe(
      `DELETE FROM elysium_target_window w
       WHERE w.span = $1::smallint AND w.edged AND w.d_txs = 0 AND w.d_fee_wei = 0 AND w.d_gas_used = 0
         AND NOT EXISTS (SELECT 1 FROM _elysium_window_edge x WHERE x.to_addr = w.to_addr)`,
      span
    );
    await tx.$executeRawUnsafe(
      `UPDATE elysium_target_window w SET txs = w.d_txs, fee_wei = w.d_fee_wei, gas_used = w.d_gas_used, edged = false
       WHERE w.span = $1::smallint AND w.edged
         AND NOT EXISTS (SELECT 1 FROM _elysium_window_edge x WHERE x.to_addr = w.to_addr)`,
      span
    );
    // Rows with an edge.
    await tx.$executeRawUnsafe(
      `UPDATE elysium_target_window w SET
         txs = w.d_txs + x.txs, fee_wei = w.d_fee_wei + x.fee, gas_used = w.d_gas_used + x.gas, edged = true
       FROM _elysium_window_edge x
       WHERE w.span = $1::smallint AND w.to_addr = x.to_addr
         AND (w.txs, w.fee_wei, w.gas_used, w.edged) IS DISTINCT FROM (w.d_txs + x.txs, w.d_fee_wei + x.fee, w.d_gas_used + x.gas, true)`,
      span
    );
    // Addresses new to the table, with their class as of now.
    await tx.$executeRawUnsafe(
      `INSERT INTO elysium_target_window (span, to_addr, txs, fee_wei, gas_used, edged, kind, deployer)
       SELECT $1::smallint, x.to_addr, x.txs, x.fee, x.gas, true, ${KIND_SQL('x.to_addr')}, c.deployer
       FROM _elysium_window_edge x
       LEFT JOIN elysium_contract c ON c.address = x.to_addr
       LEFT JOIN elysium_token k ON k.address = x.to_addr
       WHERE NOT EXISTS (SELECT 1 FROM elysium_target_window w WHERE w.span = $1::smallint AND w.to_addr = x.to_addr)`,
      span
    );
  }

  /**
   * The rows of `spans` that were no known contract, or had no deployer, set to what the
   * contract and token tables say now; how many changed, per span. Two plain joins from the
   * rows still to class (a partial index) to each table: written as one statement over the
   * two, the planner joined the window table to itself without an index and did not finish.
   */
  private async classify(tx: Tx, spans: number[]): Promise<Array<{ span: number; n: number }>> {
    return tx.$queryRawUnsafe<Array<{ span: number; n: number }>>(
      `WITH by_contract AS (
         UPDATE elysium_target_window w SET kind = 1, deployer = c.deployer
         FROM elysium_contract c
         WHERE w.span = ANY($1::smallint[]) AND (w.kind = 0 OR (w.kind = 1 AND w.deployer IS NULL)) AND c.address = w.to_addr
         RETURNING w.span, w.to_addr
       ),
       by_token AS (
         -- A row the first statement also changed is seen here as it was before: counted once below.
         UPDATE elysium_target_window w SET kind = 1
         FROM elysium_token k
         WHERE w.span = ANY($1::smallint[]) AND w.kind = 0 AND k.address = w.to_addr
           AND NOT EXISTS (SELECT 1 FROM elysium_contract c WHERE c.address = w.to_addr)
         RETURNING w.span, w.to_addr
       )
       SELECT span, count(*)::int AS n FROM (
         SELECT span, to_addr FROM by_contract UNION SELECT span, to_addr FROM by_token
       ) u GROUP BY span`,
      spans
    );
  }

  /** The totals per class in the state row, and the sums per deployer, from the table's rows as they are now. */
  private async writeTotals(tx: Tx, span: number): Promise<void> {
    await tx.$executeRawUnsafe(
      `UPDATE elysium_window_state s SET
         other_txs = t.o_txs, other_fee_wei = t.o_fee, other_gas_used = t.o_gas, other_n = t.o_n,
         app_txs = t.a_txs, app_fee_wei = t.a_fee, app_gas_used = t.a_gas, app_n = t.a_n,
         system_txs = t.s_txs, system_fee_wei = t.s_fee, system_gas_used = t.s_gas, system_n = t.s_n
       FROM (
         SELECT COALESCE(sum(txs) FILTER (WHERE kind = 0), 0) AS o_txs, COALESCE(sum(fee_wei) FILTER (WHERE kind = 0), 0) AS o_fee,
                COALESCE(sum(gas_used) FILTER (WHERE kind = 0), 0) AS o_gas, count(*) FILTER (WHERE kind = 0 AND txs > 0)::int AS o_n,
                COALESCE(sum(txs) FILTER (WHERE kind = 1), 0) AS a_txs, COALESCE(sum(fee_wei) FILTER (WHERE kind = 1), 0) AS a_fee,
                COALESCE(sum(gas_used) FILTER (WHERE kind = 1), 0) AS a_gas, count(*) FILTER (WHERE kind = 1 AND txs > 0)::int AS a_n,
                COALESCE(sum(txs) FILTER (WHERE kind = 2), 0) AS s_txs, COALESCE(sum(fee_wei) FILTER (WHERE kind = 2), 0) AS s_fee,
                COALESCE(sum(gas_used) FILTER (WHERE kind = 2), 0) AS s_gas, count(*) FILTER (WHERE kind = 2 AND txs > 0)::int AS s_n
         FROM elysium_target_window WHERE span = $1::smallint
       ) t
       WHERE s.span = $1::smallint`,
      span
    );
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE IF NOT EXISTS _elysium_window_deployer
         (deployer text PRIMARY KEY, txs bigint, fee numeric, gas numeric, contracts int) ON COMMIT DROP`
    );
    await tx.$executeRawUnsafe(`TRUNCATE _elysium_window_deployer`);
    await tx.$executeRawUnsafe(
      `INSERT INTO _elysium_window_deployer
       SELECT deployer, sum(txs)::bigint, sum(fee_wei), sum(gas_used)::numeric, count(*) FILTER (WHERE txs > 0)::int
       FROM elysium_target_window
       WHERE span = $1::smallint AND deployer IS NOT NULL
       GROUP BY deployer
       HAVING count(*) FILTER (WHERE txs > 0) > 0`,
      span
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM elysium_deployer_window w
       WHERE w.span = $1::smallint AND NOT EXISTS (SELECT 1 FROM _elysium_window_deployer d WHERE d.deployer = w.deployer)`,
      span
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO elysium_deployer_window (span, deployer, txs, fee_wei, gas_used, contracts)
       SELECT $1::smallint, deployer, txs, fee, gas, contracts FROM _elysium_window_deployer
       ON CONFLICT (span, deployer) DO UPDATE SET
         txs = EXCLUDED.txs, fee_wei = EXCLUDED.fee_wei, gas_used = EXCLUDED.gas_used, contracts = EXCLUDED.contracts
       WHERE (elysium_deployer_window.txs, elysium_deployer_window.fee_wei, elysium_deployer_window.gas_used, elysium_deployer_window.contracts)
             IS DISTINCT FROM (EXCLUDED.txs, EXCLUDED.fee_wei, EXCLUDED.gas_used, EXCLUDED.contracts)`,
      span
    );
  }
}
