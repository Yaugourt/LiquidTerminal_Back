import { randomUUID } from 'crypto';
import { prismaHistorical } from '../../core/prisma.historical.service';
import { BRIDGE_TX_TYPES } from '../../services/elysium/elysium-ingest.util';
import { ROLLUP_CALLER_SET_MIN_TXS } from '../../services/elysium/elysium-rollup.util';

/** Constant SQL list of the bridge tx types (no user input involved). */
const BRIDGE_TYPES_SQL = BRIDGE_TX_TYPES.map((t) => `'${t}'`).join(', ');

/** Time limit of one day's build: it reads that day of elysium_tx once (up to a few million rows). */
const BUILD_TIMEOUT_MS = 900_000;
/** Key of the advisory lock that keeps two builds from running at once, on whatever process. */
const BUILD_LOCK_KEY = 'elysium_day_rollup';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RollupDayState {
  day: string;
  built: boolean;
  dirty: boolean;
  callers: boolean;
  senders: boolean;
}

export type RollupBuildResult =
  /** The day is built. */
  | 'built'
  /** A transaction of that day arrived during the build: nothing was kept, the next pass redoes it. */
  | 'dirty'
  /** Another build holds the lock. */
  | 'busy';

class RollupDayDirtyError extends Error {}
class RollupBusyError extends Error {}

function assertDay(day: string): void {
  if (!DAY_RE.test(day)) throw new Error(`Invalid rollup day: ${day}`);
}

/**
 * Write side of the Elysium day rollups (historical DB). A day is rebuilt
 * whole, inside one transaction: readers see the previous state or the new
 * one, never half a day.
 */
export class ElysiumRollupRepository {
  private static instance: ElysiumRollupRepository;

  public static getInstance(): ElysiumRollupRepository {
    if (!ElysiumRollupRepository.instance) {
      ElysiumRollupRepository.instance = new ElysiumRollupRepository();
    }
    return ElysiumRollupRepository.instance;
  }

  /** Every day row from `sinceDay` on, whatever its state. */
  public async listDays(sinceDay: string): Promise<RollupDayState[]> {
    assertDay(sinceDay);
    const rows = await prismaHistorical.$queryRawUnsafe<
      Array<{ day: string; built: boolean; dirty: boolean; callers_built: boolean; senders_built: boolean }>
    >(
      `SELECT day::text AS day, (built_at IS NOT NULL) AS built, dirty, callers_built, senders_built
       FROM elysium_day_rollup WHERE day >= $1::date ORDER BY day`,
      sinceDay
    );
    return rows.map((r) => ({
      day: r.day.slice(0, 10),
      built: r.built,
      dirty: r.dirty,
      callers: r.callers_built,
      senders: r.senders_built,
    }));
  }

  /**
   * Builds the rollups of one UTC day from elysium_tx.
   *
   * The day's row is first reset (not built, not dirty) and stamped with this
   * build's token. The tx insert marks a past day dirty in the same statement
   * that stores a transaction of it, and the last statement here only declares
   * the day built if it is still not dirty and still carries the token: a
   * transaction that arrives at any point of the build either is in what was
   * read, or leaves the day dirty for the next pass, and a second build that
   * reset the row meanwhile (erasing a dirty mark) takes the token with it. A
   * day is never declared built without one of its transactions.
   */
  public async buildDay(day: string, opts: { callers: boolean; senders: boolean }): Promise<RollupBuildResult> {
    assertDay(day);
    const from = `${day}T00:00:00.000Z`;
    const to = new Date(Date.parse(from) + 86_400_000).toISOString();
    const token = randomUUID();

    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_day_rollup (day, built_at, dirty, build_token) VALUES ($1::date, NULL, false, $2)
       ON CONFLICT (day) DO UPDATE SET built_at = NULL, dirty = false, build_token = EXCLUDED.build_token`,
      day,
      token
    );

    try {
      await prismaHistorical.$transaction(
        async (tx) => {
          const lock = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
            `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
            BUILD_LOCK_KEY
          );
          if (!lock[0]?.ok) throw new RollupBusyError();

          // No parallel workers: they need shared memory the database host is short of.
          await tx.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`);
          await tx.$executeRawUnsafe(`SET LOCAL work_mem = '64MB'`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${BUILD_TIMEOUT_MS}`);

          // The day is read once, into a table of this transaction: every rollup below is
          // computed from the same rows.
          await tx.$executeRawUnsafe(
            `CREATE TEMP TABLE _elysium_rollup_src (
               from_addr text, to_addr text, method_id text, tx_type text,
               success boolean, is_spam boolean, gas_used bigint, fee_wei numeric
             ) ON COMMIT DROP`
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO _elysium_rollup_src
             SELECT from_addr, to_addr, method_id, tx_type, success, is_spam, gas_used, fee_wei
             FROM elysium_tx WHERE block_time >= $1::timestamptz AND block_time < $2::timestamptz`,
            from,
            to
          );
          await tx.$executeRawUnsafe(`ANALYZE _elysium_rollup_src`);

          await tx.$executeRawUnsafe(`DELETE FROM elysium_call_day WHERE day = $1::date`, day);
          await tx.$executeRawUnsafe(`DELETE FROM elysium_caller_day WHERE day = $1::date`, day);
          await tx.$executeRawUnsafe(`DELETE FROM elysium_caller_set WHERE day = $1::date`, day);
          await tx.$executeRawUnsafe(`DELETE FROM elysium_method_sender_day WHERE day = $1::date`, day);

          await tx.$executeRawUnsafe(
            `INSERT INTO elysium_call_day (day, to_addr, method_id, txs, failed, fee_wei, gas_used)
             SELECT $1::date, to_addr, COALESCE(method_id, ''), count(*)::int,
                    count(*) FILTER (WHERE NOT success)::int, COALESCE(sum(fee_wei), 0), COALESCE(sum(gas_used), 0)
             FROM _elysium_rollup_src
             WHERE NOT is_spam AND to_addr IS NOT NULL
             GROUP BY to_addr, COALESCE(method_id, '')`,
            day
          );
          if (opts.callers) {
            await tx.$executeRawUnsafe(
              `INSERT INTO elysium_caller_set (day, to_addr, callers)
               SELECT $1::date, to_addr, count(DISTINCT from_addr)::int
               FROM _elysium_rollup_src
               WHERE NOT is_spam AND to_addr IS NOT NULL
               GROUP BY to_addr HAVING count(*) >= $2::int`,
              day,
              ROLLUP_CALLER_SET_MIN_TXS
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO elysium_caller_day (day, to_addr, from_addr)
               SELECT DISTINCT $1::date, t.to_addr, t.from_addr
               FROM _elysium_rollup_src t
               JOIN elysium_caller_set s ON s.day = $1::date AND s.to_addr = t.to_addr
               WHERE NOT t.is_spam`,
              day
            );
          }
          if (opts.senders) {
            await tx.$executeRawUnsafe(
              `INSERT INTO elysium_method_sender_day (day, method_id, from_addr)
               SELECT DISTINCT $1::date, method_id, from_addr
               FROM _elysium_rollup_src
               WHERE NOT is_spam AND to_addr IS NOT NULL AND method_id IS NOT NULL`,
              day
            );
          }

          const done = await tx.$executeRawUnsafe(
            `UPDATE elysium_day_rollup r SET
               built_at = now(), callers_built = $2::boolean, senders_built = $3::boolean,
               txs = t.txs, failed_txs = t.failed, bridge_txs = t.bridge, calls = t.calls,
               transfers = t.transfers, creations = t.creations, spam_txs = t.spam, fee_wei = t.fee
             FROM (
               SELECT count(*) FILTER (WHERE NOT is_spam)::int AS txs,
                      count(*) FILTER (WHERE NOT is_spam AND NOT success)::int AS failed,
                      count(*) FILTER (WHERE NOT is_spam AND tx_type IN (${BRIDGE_TYPES_SQL}))::int AS bridge,
                      count(*) FILTER (WHERE NOT is_spam AND to_addr IS NOT NULL AND method_id IS NOT NULL)::int AS calls,
                      count(*) FILTER (WHERE NOT is_spam AND to_addr IS NOT NULL AND method_id IS NULL)::int AS transfers,
                      count(*) FILTER (WHERE NOT is_spam AND to_addr IS NULL)::int AS creations,
                      count(*) FILTER (WHERE is_spam)::int AS spam,
                      COALESCE(sum(fee_wei), 0) AS fee
               FROM _elysium_rollup_src
             ) t
             WHERE r.day = $1::date AND NOT r.dirty AND r.build_token = $4`,
            day,
            opts.callers,
            opts.senders,
            token
          );
          if (done === 0) throw new RollupDayDirtyError();
        },
        // Prisma's own limits for an interactive transaction are 5 s and 2 s by default.
        { timeout: BUILD_TIMEOUT_MS + 30_000, maxWait: 20_000 }
      );
    } catch (error) {
      if (error instanceof RollupDayDirtyError) return 'dirty';
      if (error instanceof RollupBusyError) return 'busy';
      throw error;
    }
    return 'built';
  }

  /**
   * Drops what is older than each table keeps. The sender lists go first and
   * their flag with them, in one transaction: a day never says it has a list
   * that is gone.
   */
  public async prune(first: { calls: string; callers: string; senders: string }): Promise<number> {
    assertDay(first.calls);
    assertDay(first.callers);
    assertDay(first.senders);
    return prismaHistorical.$transaction(
      async (tx) => {
        let removed = 0;
        await tx.$executeRawUnsafe(
          `UPDATE elysium_day_rollup SET senders_built = false WHERE day < $1::date AND senders_built`,
          first.senders
        );
        removed += await tx.$executeRawUnsafe(`DELETE FROM elysium_method_sender_day WHERE day < $1::date`, first.senders);
        await tx.$executeRawUnsafe(
          `UPDATE elysium_day_rollup SET callers_built = false WHERE day < $1::date AND callers_built`,
          first.callers
        );
        removed += await tx.$executeRawUnsafe(`DELETE FROM elysium_caller_day WHERE day < $1::date`, first.callers);
        removed += await tx.$executeRawUnsafe(`DELETE FROM elysium_caller_set WHERE day < $1::date`, first.callers);
        await tx.$executeRawUnsafe(`DELETE FROM elysium_day_rollup WHERE day < $1::date`, first.calls);
        removed += await tx.$executeRawUnsafe(`DELETE FROM elysium_call_day WHERE day < $1::date`, first.calls);
        return removed;
      },
      { timeout: 300_000, maxWait: 20_000 }
    );
  }
}
