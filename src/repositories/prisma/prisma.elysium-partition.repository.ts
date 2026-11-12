import { prismaHistorical } from '../../core/prisma.historical.service';
import { pgErrorCode } from '../../services/elysium/elysium-ingest.util';
import {
  dayKey,
  dayStartMs,
  partitionDay,
  partitionName,
  PARTITIONS_AHEAD_DAYS,
  type TxPartition,
} from '../../services/elysium/elysium-retention.util';
import { BUILD_LOCK_KEY } from './prisma.elysium-rollup.repository';

const DAY_MS = 86_400_000;

/** The table that holds everything stored before elysium_tx was split by day. */
export const LEGACY_PARTITION = 'elysium_tx_legacy';
/** The check that says every row of the table still to split is before the day the split starts. */
const SPLIT_BOUND_CONSTRAINT = 'elysium_tx_split_bound';

/**
 * A statement of the split that needs the table for itself waits this long for it, then gives
 * the pass up: every statement that arrives meanwhile waits behind it.
 */
const EXCLUSIVE_LOCK_TIMEOUT_MS = 2_000;
/** The one pass over every row of elysium_tx (the check of the bound): no time limit of the pool's applies to it. */
const VALIDATE_TIMEOUT_MS = 3 * 3_600_000;

export interface TxLayout {
  /** elysium_tx is split by day. */
  partitioned: boolean;
  /** Its tables, oldest first (empty while it is not split). */
  parts: TxPartition[];
  /** A table whose detach was started and not finished. */
  detaching: string[];
  /** A part taken out of elysium_tx whose table is still there (a drop that stopped between its two statements). */
  orphans: string[];
  /** While not split: the bound being prepared, and whether every row was checked against it. */
  pending: { cutMs: number; validated: boolean } | null;
}

export type SplitStep =
  /** Nothing was changed: the table was busy, or a rollup build was running. Tried again on the next pass. */
  | 'busy'
  | 'done';

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid table name: ${name}`);
  return `"${name}"`;
}

function isoDay(ms: number): string {
  if (!Number.isFinite(ms) || ms % DAY_MS !== 0) throw new Error(`Not the start of a UTC day: ${ms}`);
  return new Date(ms).toISOString();
}

/** Postgres gave up waiting for a lock (lock_timeout): the table was busy, nothing was changed. */
function isLockTimeout(error: unknown): boolean {
  return pgErrorCode(error) === '55P03';
}

/**
 * The layout of elysium_tx on disk (historical DB): one table until the split,
 * then one table per UTC day under a partitioned parent, so that a day can be
 * dropped as a whole.
 *
 * The split never copies the rows. The table as it is becomes the first part
 * ("everything before day X", X two days ahead), and the days from X on get
 * their own tables:
 *
 * 1. `prepare`: a check "block_time < X" is added, not yet verified (instant);
 * 2. `validate`: Postgres verifies it against every row, once, while reads and
 *    writes go on (the only long step);
 * 3. `split`: in one short transaction the table is renamed, an empty
 *    partitioned elysium_tx is created with it as its first part (the verified
 *    check lets Postgres attach it without reading it), and the tables of the
 *    first days are added.
 *
 * The parent has no primary key (a key on a split table must hold the time):
 * each part keeps its own unique index on tx_hash, which is what the tx insert
 * conflicts on, and the insert also looks for the hash a day around the row's
 * time. Every statement that looked a transaction up by hash alone now names
 * its block time too.
 */
export class ElysiumPartitionRepository {
  private static instance: ElysiumPartitionRepository;

  public static getInstance(): ElysiumPartitionRepository {
    if (!ElysiumPartitionRepository.instance) ElysiumPartitionRepository.instance = new ElysiumPartitionRepository();
    return ElysiumPartitionRepository.instance;
  }

  /** The server's version as a number (160004 for 16.4). */
  public async serverVersion(): Promise<number> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ v: number }>>(`SELECT current_setting('server_version_num')::int AS v`);
    return Number(rows[0]?.v ?? 0);
  }

  /** How elysium_tx is laid out now. Read from the catalog: no state of ours to keep in step with it. */
  public async layout(): Promise<TxLayout> {
    const kind = await prismaHistorical.$queryRawUnsafe<Array<{ relkind: string }>>(
      `SELECT c.relkind::text AS relkind FROM pg_class c
       WHERE c.relname = 'elysium_tx' AND c.relnamespace = current_schema()::regnamespace`
    );
    if (kind[0]?.relkind !== 'p') {
      // The bound is read back as an instant by the server itself (the catalog prints it in the session's time zone).
      const check = await prismaHistorical.$queryRawUnsafe<Array<{ validated: boolean; cut_ms: number | null }>>(
        `SELECT con.convalidated AS validated,
                (extract(epoch FROM (regexp_match(pg_get_constraintdef(con.oid), '''([^'']+)'''))[1]::timestamptz) * 1000)::float8 AS cut_ms
         FROM pg_constraint con
         WHERE con.conname = '${SPLIT_BOUND_CONSTRAINT}' AND con.conrelid = to_regclass('elysium_tx')`
      );
      const c = check[0];
      return {
        partitioned: false,
        parts: [],
        detaching: [],
        orphans: [],
        pending: c && c.cut_ms !== null ? { cutMs: Math.round(Number(c.cut_ms)), validated: c.validated } : null,
      };
    }
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ name: string; lo_ms: number | null; hi_ms: number | null; pending: boolean }>>(
      `SELECT child.relname::text AS name,
              (extract(epoch FROM (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM \\(''([^'']+)''\\)'))[1]::timestamptz) * 1000)::float8 AS lo_ms,
              (extract(epoch FROM (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz) * 1000)::float8 AS hi_ms,
              i.inhdetachpending AS pending
       FROM pg_inherits i
       JOIN pg_class child ON child.oid = i.inhrelid
       WHERE i.inhparent = to_regclass('elysium_tx')`
    );
    const parts: TxPartition[] = [];
    const detaching: string[] = [];
    for (const r of rows) {
      if (r.pending) {
        detaching.push(r.name);
        continue;
      }
      if (r.hi_ms === null) continue; // not one of ours (no upper bound): never touched
      parts.push({ name: r.name, fromMs: r.lo_ms === null ? null : Math.round(Number(r.lo_ms)), toMs: Math.round(Number(r.hi_ms)) });
    }
    parts.sort((a, b) => a.toMs - b.toMs);
    // Tables with a part's name that are no longer parts: only a drop makes one (a day table is
    // created and attached in one transaction), when it stopped after the detach.
    const loose = await prismaHistorical.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT c.relname::text AS name FROM pg_class c
       WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
         AND (c.relname = '${LEGACY_PARTITION}' OR c.relname ~ '^elysium_tx_d[0-9]{8}$')
         AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)`
    );
    return { partitioned: true, parts, detaching, orphans: loose.map((r) => r.name), pending: null };
  }

  /**
   * Step 1 of the split: the check "every row is before `cutMs`" (the start of a UTC day ahead),
   * added without verifying it. A check left by an earlier try with another bound is replaced.
   */
  public async prepare(cutMs: number): Promise<SplitStep> {
    const cut = isoDay(cutMs);
    try {
      await prismaHistorical.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${EXCLUSIVE_LOCK_TIMEOUT_MS}`);
          await tx.$executeRawUnsafe(`ALTER TABLE elysium_tx DROP CONSTRAINT IF EXISTS ${SPLIT_BOUND_CONSTRAINT}`);
          await tx.$executeRawUnsafe(
            `ALTER TABLE elysium_tx ADD CONSTRAINT ${SPLIT_BOUND_CONSTRAINT} CHECK (block_time < '${cut}'::timestamptz) NOT VALID`
          );
        },
        { timeout: 30_000, maxWait: 20_000 }
      );
    } catch (error) {
      if (isLockTimeout(error)) return 'busy';
      throw error;
    }
    return 'done';
  }

  /**
   * Step 2: Postgres verifies the check against every row. One pass over the whole table, under
   * a lock that lets every read and write go on (it only keeps another change of the table's
   * definition, and a vacuum of it, waiting).
   */
  public async validate(): Promise<void> {
    await prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${VALIDATE_TIMEOUT_MS}`);
        await tx.$executeRawUnsafe(`ALTER TABLE elysium_tx VALIDATE CONSTRAINT ${SPLIT_BOUND_CONSTRAINT}`);
      },
      { timeout: VALIDATE_TIMEOUT_MS + 60_000, maxWait: 20_000 }
    );
  }

  /**
   * Step 3: the split itself, in one transaction that holds the table for itself for a few
   * milliseconds. It gives up at once ('busy') while a rollup build runs or the table cannot be
   * had within EXCLUSIVE_LOCK_TIMEOUT_MS, and changes nothing then.
   *
   * `cutMs` must be the bound the verified check holds: that is what lets Postgres take the
   * existing table as the part "before the bound" without reading it. `days`: the first days
   * (from the bound on) that get their own table right away.
   */
  public async split(cutMs: number, days: readonly string[]): Promise<SplitStep> {
    const cut = isoDay(cutMs);
    for (const day of days) if (dayStartMs(day) < cutMs) throw new Error(`Day ${day} is before the split`);
    try {
      return await prismaHistorical.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${EXCLUSIVE_LOCK_TIMEOUT_MS}`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 60000`);
          // No day or hour is being read into its rollup, no window table refreshed: they hold the table for minutes.
          const free = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, BUILD_LOCK_KEY);
          if (!free[0]?.ok) return 'busy' as const;
          await tx.$executeRawUnsafe(`LOCK TABLE elysium_tx IN ACCESS EXCLUSIVE MODE`);
          // Read under the lock: another process cannot replace the bound between this and the attach
          // (which would then read every row with the table held).
          const check = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
            `SELECT con.convalidated
                    AND (regexp_match(pg_get_constraintdef(con.oid), '''([^'']+)'''))[1]::timestamptz = $1::timestamptz AS ok
             FROM pg_constraint con
             WHERE con.conname = '${SPLIT_BOUND_CONSTRAINT}' AND con.conrelid = to_regclass('elysium_tx')`,
            cut
          );
          if (!check[0]?.ok) throw new Error('elysium_tx split: the bound is not verified');
          await tx.$executeRawUnsafe(`ALTER TABLE elysium_tx RENAME TO ${LEGACY_PARTITION}`);
          await tx.$executeRawUnsafe(
            `CREATE TABLE elysium_tx (LIKE ${LEGACY_PARTITION} INCLUDING DEFAULTS INCLUDING STORAGE) PARTITION BY RANGE (block_time)`
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE elysium_tx ATTACH PARTITION ${LEGACY_PARTITION} FOR VALUES FROM (MINVALUE) TO ('${cut}'::timestamptz)`
          );
          // The parent's indexes: the existing table's own are taken as they are (same columns), nothing is built.
          await tx.$executeRawUnsafe(`CREATE INDEX elysium_tx_part_block_time_idx ON elysium_tx (block_time)`);
          await tx.$executeRawUnsafe(`CREATE INDEX elysium_tx_part_to_addr_block_time_idx ON elysium_tx (to_addr, block_time)`);
          await tx.$executeRawUnsafe(`CREATE INDEX elysium_tx_part_from_addr_block_time_idx ON elysium_tx (from_addr, block_time)`);
          for (const day of days) {
            const name = quoteIdent(partitionName(day));
            const from = isoDay(dayStartMs(day));
            const to = isoDay(dayStartMs(day) + DAY_MS);
            await tx.$executeRawUnsafe(
              `CREATE TABLE ${name} PARTITION OF elysium_tx (CONSTRAINT ${quoteIdent(`${partitionName(day)}_pkey`)} PRIMARY KEY (tx_hash))
               FOR VALUES FROM ('${from}'::timestamptz) TO ('${to}'::timestamptz)`
            );
          }
          return 'done' as const;
        },
        { timeout: 90_000, maxWait: 20_000 }
      );
    } catch (error) {
      if (isLockTimeout(error)) return 'busy';
      throw error;
    }
  }

  /**
   * Makes the table of one UTC day and adds it to elysium_tx. Built apart, with its own key on
   * tx_hash and a check of its bounds, then attached: attaching only takes a lock that lets
   * reads and writes of the other days go on (creating it in place would take the whole table).
   * Does nothing when the day already has its table.
   */
  public async ensureDay(day: string): Promise<boolean> {
    const bare = partitionName(day);
    const name = quoteIdent(bare);
    const from = isoDay(dayStartMs(day));
    const to = isoDay(dayStartMs(day) + DAY_MS);
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = 20000`);
        // One maker of day tables at a time, on whatever process.
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('elysium_tx_partitions'))`);
        const there = await tx.$queryRawUnsafe<Array<{ attached: boolean }>>(
          `SELECT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid AND i.inhparent = to_regclass('elysium_tx')) AS attached
           FROM pg_class c WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
          bare
        );
        if (there[0]?.attached) return false;
        if (there.length === 0) {
          await tx.$executeRawUnsafe(`CREATE TABLE ${name} (LIKE elysium_tx INCLUDING DEFAULTS INCLUDING STORAGE)`);
          await tx.$executeRawUnsafe(`ALTER TABLE ${name} ADD CONSTRAINT ${quoteIdent(`${bare}_pkey`)} PRIMARY KEY (tx_hash)`);
          await tx.$executeRawUnsafe(
            `ALTER TABLE ${name} ADD CONSTRAINT ${quoteIdent(`${bare}_bound`)}
             CHECK (block_time >= '${from}'::timestamptz AND block_time < '${to}'::timestamptz)`
          );
        }
        await tx.$executeRawUnsafe(`ALTER TABLE elysium_tx ATTACH PARTITION ${name} FOR VALUES FROM ('${from}'::timestamptz) TO ('${to}'::timestamptz)`);
        // The bounds are the partition's own from here on.
        await tx.$executeRawUnsafe(`ALTER TABLE ${name} DROP CONSTRAINT IF EXISTS ${quoteIdent(`${bare}_bound`)}`);
        return true;
      },
      { timeout: 60_000, maxWait: 20_000 }
    );
  }

  /**
   * Takes a part out of elysium_tx and drops it. The detach waits for the statements that still
   * read the part without blocking the ones that arrive (it is not one transaction: a detach
   * interrupted half-way is finished by the next call).
   */
  public async drop(part: string, state: 'attached' | 'detaching' | 'orphan'): Promise<void> {
    if (part !== LEGACY_PARTITION && partitionDay(part) === null) throw new Error(`Not a part of elysium_tx: ${part}`);
    const name = quoteIdent(part);
    if (state === 'orphan') {
      // Already taken out: only its table is left.
      await prismaHistorical.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name}`);
      return;
    }
    // Each statement on its own (a concurrent detach cannot run inside a transaction), under the
    // writers' pool's own limits: it waits at most that long for the statements still reading the part.
    if (state === 'detaching') {
      await prismaHistorical.$executeRawUnsafe(`ALTER TABLE elysium_tx DETACH PARTITION ${name} FINALIZE`);
    } else {
      await prismaHistorical.$executeRawUnsafe(`ALTER TABLE elysium_tx DETACH PARTITION ${name} CONCURRENTLY`);
    }
    await prismaHistorical.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name}`);
  }

  private floor: { at: number; ms: number | null } | null = null;

  /**
   * The first instant elysium_tx can hold: the start of its oldest part once the table of
   * everything before the split is gone, null before that (nothing is too old). Read from the
   * catalog at most once a minute.
   */
  public async floorMs(): Promise<number | null> {
    if (this.floor && Date.now() - this.floor.at < 60_000) return this.floor.ms;
    const layout = await this.layout();
    const first = layout.parts[0];
    const ms = layout.partitioned && first ? first.fromMs : null;
    this.floor = { at: Date.now(), ms };
    return ms;
  }

  /** Forgets the floor read last (a part was just dropped). */
  public forgetFloor(): void {
    this.floor = null;
  }

  /**
   * For an insert that found no table for one of its rows: makes the tables of the UTC days
   * given that have none, among today, the days ahead and the days since the split (never a
   * day before the oldest part, never a day far ahead: a row with an absurd time must not get a
   * table). Returns how many were made (1 when it took off a split bound that time has passed).
   */
  public async ensureDaysFor(days: readonly string[], now: Date): Promise<number> {
    const layout = await this.layout();
    if (!layout.partitioned) {
      // Not split yet, and a row is at or past the bound a split was prepared with: the split was
      // left unfinished for days (the upkeep pass stopped). The bound is taken off so that the
      // table takes its rows again; the upkeep prepares a new one when it runs.
      const cut = layout.pending?.cutMs;
      const ahead = Math.floor(now.getTime() / DAY_MS) * DAY_MS + PARTITIONS_AHEAD_DAYS * DAY_MS;
      // Only for a row of today or the days ahead: a row with an absurd time is refused, and the bound stays.
      if (cut === undefined || !days.some((day) => dayStartMs(day) + DAY_MS > cut && dayStartMs(day) <= ahead)) return 0;
      await prismaHistorical.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${EXCLUSIVE_LOCK_TIMEOUT_MS}`);
          await tx.$executeRawUnsafe(`ALTER TABLE elysium_tx DROP CONSTRAINT IF EXISTS ${SPLIT_BOUND_CONSTRAINT}`);
        },
        { timeout: 30_000, maxWait: 20_000 }
      );
      return 1;
    }
    if (layout.parts.length === 0) return 0;
    const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
    const last = today + PARTITIONS_AHEAD_DAYS * DAY_MS;
    const first = Math.min(...layout.parts.map((p) => p.fromMs ?? p.toMs));
    let made = 0;
    for (const day of [...new Set(days)].sort()) {
      const start = dayStartMs(day);
      if (!Number.isFinite(start) || dayKey(start) !== day || start < first || start > last) continue;
      if (layout.parts.some((p) => (p.fromMs === null || p.fromMs <= start) && start < p.toMs)) continue;
      if (await this.ensureDay(day)) made += 1;
    }
    return made;
  }

  /** The time of the newest transaction held (epoch ms); null when there is none. */
  public async newestTxMs(): Promise<number | null> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ ms: number | null }>>(
      `SELECT (extract(epoch FROM max(block_time)) * 1000)::float8 AS ms FROM elysium_tx`
    );
    const ms = rows[0]?.ms;
    return ms === null || ms === undefined ? null : Math.round(Number(ms));
  }

  /** The UTC days of the last `days` whose rollup is built and not marked to be rebuilt. */
  public async builtRollupDays(days: number): Promise<Set<string>> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ day: string }>>(
      `SELECT day::text AS day FROM elysium_day_rollup
       WHERE built_at IS NOT NULL AND NOT dirty AND day >= (now() AT TIME ZONE 'UTC')::date - $1::int`,
      days
    );
    return new Set(rows.map((r) => r.day.slice(0, 10)));
  }

  /** Fresh statistics for the planner: a partitioned table is not analysed on its own by autovacuum. */
  public async analyze(): Promise<void> {
    await prismaHistorical.$executeRawUnsafe(`ANALYZE elysium_tx`);
  }
}
