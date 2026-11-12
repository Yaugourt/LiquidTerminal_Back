import { prismaHistorical } from '../../core/prisma.historical.service';
import { dayStartMs, nextDay } from '../../services/elysium/elysium-retention.util';

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Time limit of one fold: a UTC day of elysium_tx read once, or a week of the directory's contracts. */
const FOLD_TIMEOUT_MS = 900_000;
/** A fold waits this long for an insert of old rows that holds the facts' lock, then gives the pass up. */
const FOLD_LOCK_TIMEOUT_MS = 20_000;
/** Time limit of one pass of the sender copy over a span of days. */
const SENDER_TIMEOUT_MS = 300_000;
/** Days of a directory contract's history folded in one transaction (its first fold goes back to its first call). */
export const PROJECT_FOLD_DAYS = 7;

/** The one set of facts folded by day for every address: elysium_target_seen and elysium_address_method. */
export const HISTORY_FACT = 'history';

function assertDay(day: string): void {
  if (!DAY_RE.test(day)) throw new Error(`Invalid fact day: ${day}`);
}

/**
 * SQL that takes the facts' lock (the 'history' row of elysium_fact_state) and returns the day
 * the history facts go up to. Whoever holds it is alone to move the facts: a fold, or an
 * insert of transactions old enough to belong to a folded day.
 */
export const LOCK_FACTS_SQL = `SELECT through_day::text AS through FROM elysium_fact_state WHERE fact = '${HISTORY_FACT}' FOR UPDATE`;

export interface FactsStanding {
  /** Last UTC day folded into elysium_target_seen and elysium_address_method; null before the first. */
  history: string | null;
  /** The directory contracts given, and how many of them are folded up to `projectsThrough`. */
  projects: number;
  /** The day every directory contract given is folded up to at least; null when one is not folded at all. */
  projectsThrough: string | null;
}

/**
 * Write side of what stands in for old transactions (historical DB):
 *
 * - the sender of the transaction, copied onto the swaps, launchpad trades and launches read
 *   from its logs (`tx_from`);
 * - the history facts: per called address its first and last transaction, per sender its
 *   transactions by method, per directory contract and sender its transactions. Folded one
 *   final UTC day at a time, each in a transaction that also moves the day the facts go up to:
 *   a reader that takes both in one statement adds elysium_tx from the next day on and counts
 *   every transaction once.
 */
export class ElysiumFactsRepository {
  private static instance: ElysiumFactsRepository;

  public static getInstance(): ElysiumFactsRepository {
    if (!ElysiumFactsRepository.instance) ElysiumFactsRepository.instance = new ElysiumFactsRepository();
    return ElysiumFactsRepository.instance;
  }

  // ---------------------------------------------------------------------------
  // The transaction's sender on the rows read from its logs
  // ---------------------------------------------------------------------------

  /**
   * Copies the sender of their transaction onto the swaps, the trades without a trader and the
   * launches without a creator of ]after, upTo] that do not have it yet. A row and its
   * transaction are in the same block, so they carry the same time: the lookup names the hash
   * and the time, and only reads the days of the span. A row whose transaction elysium_tx does
   * not hold is left as it is. Returns how many rows got a sender.
   */
  public async copyTxSenders(after: Date, upTo: Date): Promise<{ swaps: number; trades: number; launches: number }> {
    if (!(after.getTime() < upTo.getTime())) return { swaps: 0, trades: 0, launches: 0 };
    const from = after.toISOString();
    const to = upTo.toISOString();
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${SENDER_TIMEOUT_MS}`);
        const swaps = await tx.$executeRawUnsafe(
          `UPDATE elysium_dex_swap s SET tx_from = t.from_addr
           FROM elysium_tx t
           WHERE s.tx_from IS NULL AND s.block_time > $1::timestamptz AND s.block_time <= $2::timestamptz
             AND t.block_time > $1::timestamptz AND t.block_time <= $2::timestamptz
             AND t.tx_hash = s.tx_hash AND t.block_time = s.block_time`,
          from,
          to
        );
        const trades = await tx.$executeRawUnsafe(
          `UPDATE elysium_launch_trade s SET tx_from = t.from_addr
           FROM elysium_tx t
           WHERE s.trader IS NULL AND s.tx_from IS NULL
             AND s.block_time > $1::timestamptz AND s.block_time <= $2::timestamptz
             AND t.block_time > $1::timestamptz AND t.block_time <= $2::timestamptz
             AND t.tx_hash = s.tx_hash AND t.block_time = s.block_time`,
          from,
          to
        );
        // The launches are locked first and in one order, as every writer of a launch does (the
        // trade insert, a rebuild of the market state): two of them then wait for each other
        // instead of deadlocking.
        await tx.$queryRawUnsafe(
          `SELECT token FROM elysium_launch
           WHERE creator IS NULL AND tx_from IS NULL
             AND created_at > $1::timestamptz AND created_at <= $2::timestamptz
           ORDER BY token FOR UPDATE`,
          from,
          to
        );
        const launches = await tx.$executeRawUnsafe(
          `UPDATE elysium_launch l SET tx_from = t.from_addr
           FROM elysium_tx t
           WHERE l.creator IS NULL AND l.tx_from IS NULL
             AND l.created_at > $1::timestamptz AND l.created_at <= $2::timestamptz
             AND t.block_time > $1::timestamptz AND t.block_time <= $2::timestamptz
             AND t.tx_hash = l.tx_hash AND t.block_time = l.created_at`,
          from,
          to
        );
        return { swaps, trades, launches };
      },
      { timeout: SENDER_TIMEOUT_MS + 30_000, maxWait: 20_000 }
    );
  }

  // ---------------------------------------------------------------------------
  // History facts
  // ---------------------------------------------------------------------------

  /** The UTC day of the oldest transaction held; null when there is none. */
  public async firstTxDay(): Promise<string | null> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ day: string | null }>>(
      `SELECT ((min(block_time) AT TIME ZONE 'UTC')::date)::text AS day FROM elysium_tx`
    );
    return rows[0]?.day ? rows[0].day.slice(0, 10) : null;
  }

  /** Makes sure the facts' state row is there (the lock is a lock on it). */
  public async ensureState(): Promise<void> {
    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_fact_state (fact) VALUES ('${HISTORY_FACT}') ON CONFLICT (fact) DO NOTHING`
    );
  }

  /**
   * Where the facts stand: the history facts, and the directory contracts given (the ones the
   * directory lists now; a contract it no longer lists does not hold anything back).
   */
  public async standing(contracts: readonly string[]): Promise<FactsStanding> {
    const rows = await prismaHistorical.$queryRawUnsafe<
      Array<{ history: string | null; known: number; unfolded: number; through: string | null }>
    >(
      `SELECT (SELECT through_day::text FROM elysium_fact_state WHERE fact = '${HISTORY_FACT}') AS history,
              count(c.to_addr)::int AS known,
              count(*) FILTER (WHERE c.through_day IS NULL)::int AS unfolded,
              min(c.through_day)::text AS through
       FROM unnest($1::text[]) AS a(addr)
       LEFT JOIN elysium_project_contract c ON c.to_addr = a.addr`,
      [...contracts]
    );
    const r = rows[0];
    const history = r?.history ? r.history.slice(0, 10) : null;
    if (contracts.length === 0) return { history, projects: 0, projectsThrough: history };
    const complete = r !== undefined && Number(r.unfolded) === 0 && Number(r.known) === contracts.length;
    return {
      history,
      projects: contracts.length,
      projectsThrough: complete && r?.through ? r.through.slice(0, 10) : null,
    };
  }

  /**
   * Folds one UTC day of elysium_tx into the history facts, and moves the day they go up to, in
   * one transaction. `day` must be the day after the one the facts stand at (or `first`, the
   * first day ever, when nothing was folded): anything else returns 'moved' and changes
   * nothing, so two folds of the same day cannot both add it.
   */
  public async foldHistoryDay(day: string, first: boolean): Promise<'folded' | 'moved'> {
    assertDay(day);
    const from = new Date(dayStartMs(day)).toISOString();
    const to = new Date(dayStartMs(day) + DAY_MS).toISOString();
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${FOLD_LOCK_TIMEOUT_MS}`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${FOLD_TIMEOUT_MS}`);
        // No parallel workers: they need shared memory the database host is short of.
        await tx.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`);
        await tx.$executeRawUnsafe(`SET LOCAL work_mem = '64MB'`);
        const state = await tx.$queryRawUnsafe<Array<{ through: string | null }>>(LOCK_FACTS_SQL);
        if (state.length === 0) return 'moved';
        const through = state[0].through ? state[0].through.slice(0, 10) : null;
        if (through === null ? !first : nextDay(through) !== day) return 'moved';

        // The day is read once, into a table of this transaction: both facts come from the same rows.
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE _elysium_fold_src ON COMMIT DROP AS
           SELECT from_addr, to_addr, method_id, is_spam, block_time
           FROM elysium_tx WHERE block_time >= $1::timestamptz AND block_time < $2::timestamptz`,
          from,
          to
        );
        await tx.$executeRawUnsafe(`ANALYZE _elysium_fold_src`);
        await tx.$executeRawUnsafe(
          `INSERT INTO elysium_target_seen (to_addr, first_at, last_at)
           SELECT to_addr, min(block_time), max(block_time)
           FROM _elysium_fold_src WHERE to_addr IS NOT NULL
           GROUP BY to_addr
           ON CONFLICT (to_addr) DO UPDATE
             SET first_at = LEAST(elysium_target_seen.first_at, EXCLUDED.first_at),
                 last_at = GREATEST(elysium_target_seen.last_at, EXCLUDED.last_at)`
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO elysium_address_method (address, method_key, txs)
           SELECT from_addr, CASE WHEN to_addr IS NULL THEN 'create' ELSE COALESCE(method_id, '') END, count(*)
           FROM _elysium_fold_src WHERE NOT is_spam
           GROUP BY 1, 2
           ON CONFLICT (address, method_key) DO UPDATE SET txs = elysium_address_method.txs + EXCLUDED.txs`
        );
        await tx.$executeRawUnsafe(
          `UPDATE elysium_fact_state SET through_day = $1::date, updated_at = now() WHERE fact = '${HISTORY_FACT}'`,
          day
        );
        return 'folded';
      },
      { timeout: FOLD_TIMEOUT_MS + 30_000, maxWait: 20_000 }
    );
  }

  /** Lists the directory's contracts in elysium_project_contract (a new one starts unfolded). */
  public async registerProjectContracts(contracts: readonly string[]): Promise<void> {
    if (contracts.length === 0) return;
    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_project_contract (to_addr)
       SELECT DISTINCT a FROM unnest($1::text[]) AS a
       ON CONFLICT (to_addr) DO NOTHING`,
      [...contracts]
    );
  }

  /**
   * Brings the directory contracts given closer to `upTo` (a final UTC day): the ones furthest
   * behind (they stand at the same day) are folded together, at most PROJECT_FOLD_DAYS days
   * further, from `first` (the first day elysium_tx holds) when they were never folded. One
   * transaction, under the facts' lock. Returns how many contracts moved, and whether some are
   * still behind.
   */
  public async foldProjectContracts(
    contracts: readonly string[],
    upTo: string,
    first: string
  ): Promise<{ moved: number; behind: boolean }> {
    assertDay(upTo);
    assertDay(first);
    if (contracts.length === 0) return { moved: 0, behind: false };
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${FOLD_LOCK_TIMEOUT_MS}`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${FOLD_TIMEOUT_MS}`);
        await tx.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`);
        await tx.$executeRawUnsafe(`SET LOCAL work_mem = '64MB'`);
        const lock = await tx.$queryRawUnsafe<Array<{ through: string | null }>>(LOCK_FACTS_SQL);
        if (lock.length === 0) return { moved: 0, behind: true };
        const groups = await tx.$queryRawUnsafe<Array<{ through: string | null; addrs: string[] }>>(
          `SELECT through_day::text AS through, array_agg(to_addr ORDER BY to_addr) AS addrs
           FROM elysium_project_contract
           WHERE to_addr = ANY($1::text[]) AND (through_day IS NULL OR through_day < $2::date)
           GROUP BY through_day
           ORDER BY through_day NULLS FIRST`,
          [...contracts],
          upTo
        );
        // One group per transaction, the one furthest behind: each is one statement with its own time limit.
        const group = groups[0];
        if (!group) return { moved: 0, behind: false };
        const through = group.through ? group.through.slice(0, 10) : null;
        const fromDay = through === null ? first : nextDay(through);
        // Never folded and nothing final to fold yet (a history shorter than a final day).
        if (fromDay > upTo) return { moved: 0, behind: false };
        const lastMs = Math.min(dayStartMs(upTo), dayStartMs(fromDay) + (PROJECT_FOLD_DAYS - 1) * DAY_MS);
        const last = new Date(lastMs).toISOString().slice(0, 10);
        await tx.$executeRawUnsafe(
          `INSERT INTO elysium_project_wallet (to_addr, from_addr, txs, first_at)
           SELECT t.to_addr, t.from_addr, count(*), min(t.block_time)
           FROM elysium_tx t
           WHERE t.to_addr = ANY($1::text[]) AND NOT t.is_spam
             AND t.block_time >= $2::timestamptz AND t.block_time < $3::timestamptz
           GROUP BY t.to_addr, t.from_addr
           ON CONFLICT (to_addr, from_addr) DO UPDATE
             SET txs = elysium_project_wallet.txs + EXCLUDED.txs,
                 first_at = LEAST(elysium_project_wallet.first_at, EXCLUDED.first_at)`,
          group.addrs,
          new Date(dayStartMs(fromDay)).toISOString(),
          new Date(lastMs + DAY_MS).toISOString()
        );
        // Guarded by the day the group stood at: read under the lock, it cannot have moved.
        const moved = await tx.$executeRawUnsafe(
          `UPDATE elysium_project_contract SET through_day = $2::date
           WHERE to_addr = ANY($1::text[]) AND through_day IS NOT DISTINCT FROM $3::date`,
          group.addrs,
          last,
          through
        );
        return { moved, behind: groups.length > 1 || last < upTo };
      },
      { timeout: FOLD_TIMEOUT_MS + 30_000, maxWait: 20_000 }
    );
  }
}
