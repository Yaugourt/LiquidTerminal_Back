import { prismaHistorical, prismaHistoricalAggregate } from '../../core/prisma.historical.service';
import { BRIDGE_TX_TYPES } from '../../services/elysium/elysium-ingest.util';
import type { TxRow } from '../../services/elysium/elysium-ingest.util';

/** Constant SQL list of the bridge tx types (no user input involved). */
const BRIDGE_TYPES_SQL = BRIDGE_TX_TYPES.map((t) => `'${t}'`).join(', ');
/** A user transaction, as the insert of elysium_tx counts it for the per-address tables. */
const IS_USER_SQL = `NOT t.is_spam AND COALESCE(t.tx_type, '') NOT IN (${BRIDGE_TYPES_SQL})`;

/** Time limit of one corrective statement group (a slot of ten minutes, a few rows changed). */
const FIX_TIMEOUT_MS = 120_000;

export type DayCheckStatus = 'ok' | 'gap' | 'repairing' | 'unrepaired';

export interface DayCounts {
  txs: number;
  spam: number;
  bridge: number;
}

export interface DayCheckRow {
  day: string;
  provider: DayCounts;
  ours: DayCounts;
  status: DayCheckStatus;
  checkedAt: Date;
  gapSince: Date | null;
  /** The 144 ten-minute slots of the day, '1' once read again; null when no re-read is under way. */
  progress: string | null;
  rereads: number;
  rowsAdded: number;
  rowsCorrected: number;
  rowsRemoved: number;
  repairedAt: Date | null;
}

type Tx = Parameters<Parameters<typeof prismaHistorical.$transaction>[0]>[0];

/**
 * A user transaction entering or leaving a sender's counts: `at` is its block time, `day` its UTC
 * day. A row that changes is a leave of what it was and an enter of what it is.
 */
interface SenderEvent {
  from_addr: string;
  kind: 'enter' | 'leave';
  day: string;
  at: string;
}

function assertDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Elysium check: invalid day');
}

/**
 * The daily comparison of elysium_tx with the provider's own figures, and the statements that
 * put a day right: flags the provider changed since the row was first read, rows the provider
 * no longer lists. Rows the provider lists and we lack go through the stream's own insert.
 *
 * The per-address tables (elysium_address_day, elysium_address) are maintained by that insert
 * from the rows it adds. A row that changes or leaves afterwards moves them here, by exactly
 * what it changed (adjustSenders).
 */
export class ElysiumCheckRepository {
  private static instance: ElysiumCheckRepository;

  public static getInstance(): ElysiumCheckRepository {
    if (!ElysiumCheckRepository.instance) ElysiumCheckRepository.instance = new ElysiumCheckRepository();
    return ElysiumCheckRepository.instance;
  }

  /**
   * What elysium_tx holds for a UTC day: non-spam transactions, spam, and the bridge-driven part
   * of the non-spam ones. Read from the day's rollup when it is built and clean (the builder
   * counted the same rows, in one transaction), from the table itself otherwise.
   */
  public async ourDayCounts(day: string): Promise<DayCounts> {
    assertDay(day);
    const built = await prismaHistorical.$queryRawUnsafe<Array<{ txs: number; spam: number; bridge: number }>>(
      `SELECT txs, spam_txs AS spam, bridge_txs AS bridge FROM elysium_day_rollup
       WHERE day = $1::date AND built_at IS NOT NULL AND NOT dirty`,
      day
    );
    if (built[0]) return { txs: Number(built[0].txs), spam: Number(built[0].spam), bridge: Number(built[0].bridge) };
    // A pass over a whole day of transactions: on the aggregates' pool, like every other one
    // (its own connections and a time limit per statement), not on the writers'.
    const rows = await prismaHistoricalAggregate.$queryRawUnsafe<Array<{ txs: number; spam: number; bridge: number }>>(
      `SELECT count(*) FILTER (WHERE NOT is_spam)::int AS txs,
              count(*) FILTER (WHERE is_spam)::int AS spam,
              count(*) FILTER (WHERE NOT is_spam AND tx_type IN (${BRIDGE_TYPES_SQL}))::int AS bridge
       FROM elysium_tx
       WHERE block_time >= (($1::date)::timestamp AT TIME ZONE 'UTC')
         AND block_time < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')`,
      day
    );
    return { txs: Number(rows[0]?.txs ?? 0), spam: Number(rows[0]?.spam ?? 0), bridge: Number(rows[0]?.bridge ?? 0) };
  }

  /**
   * What elysium_tx holds for a day, per ten-minute slot (0..143): where a hole would show, and,
   * summed, the day's own counts. One pass over the day's rows.
   */
  public async slotCounts(day: string): Promise<DayCounts[]> {
    assertDay(day);
    const rows = await prismaHistoricalAggregate.$queryRawUnsafe<Array<{ slot: number; txs: number; spam: number; bridge: number }>>(
      `SELECT floor(extract(epoch FROM (block_time - (($1::date)::timestamp AT TIME ZONE 'UTC'))) / 600)::int AS slot,
              count(*) FILTER (WHERE NOT is_spam)::int AS txs,
              count(*) FILTER (WHERE is_spam)::int AS spam,
              count(*) FILTER (WHERE NOT is_spam AND tx_type IN (${BRIDGE_TYPES_SQL}))::int AS bridge
       FROM elysium_tx
       WHERE block_time >= (($1::date)::timestamp AT TIME ZONE 'UTC')
         AND block_time < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
       GROUP BY 1`,
      day
    );
    const counts = Array.from({ length: 144 }, (): DayCounts => ({ txs: 0, spam: 0, bridge: 0 }));
    for (const r of rows) {
      if (r.slot >= 0 && r.slot < 144) counts[r.slot] = { txs: Number(r.txs), spam: Number(r.spam), bridge: Number(r.bridge) };
    }
    return counts;
  }

  /** The same three counts over [start, end): a slot, after it was changed. */
  public async rangeCounts(start: Date, end: Date): Promise<DayCounts> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ txs: number; spam: number; bridge: number }>>(
      `SELECT count(*) FILTER (WHERE NOT is_spam)::int AS txs,
              count(*) FILTER (WHERE is_spam)::int AS spam,
              count(*) FILTER (WHERE NOT is_spam AND tx_type IN (${BRIDGE_TYPES_SQL}))::int AS bridge
       FROM elysium_tx WHERE block_time >= $1::timestamptz AND block_time < $2::timestamptz`,
      start.toISOString(),
      end.toISOString()
    );
    return { txs: Number(rows[0]?.txs ?? 0), spam: Number(rows[0]?.spam ?? 0), bridge: Number(rows[0]?.bridge ?? 0) };
  }

  /** The hashes we hold in [start, end): to find the ones the provider no longer lists. */
  public async txHashesBetween(start: Date, end: Date): Promise<string[]> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ tx_hash: string }>>(
      `SELECT tx_hash FROM elysium_tx WHERE block_time >= $1::timestamptz AND block_time < $2::timestamptz`,
      start.toISOString(),
      end.toISOString()
    );
    return rows.map((r) => r.tx_hash);
  }

  public async listChecks(sinceDay: string): Promise<DayCheckRow[]> {
    assertDay(sinceDay);
    const rows = await prismaHistorical.$queryRawUnsafe<
      Array<{
        day: string;
        provider_txs: number;
        provider_spam: number;
        provider_bridge: number;
        our_txs: number;
        our_spam: number;
        our_bridge: number;
        status: string;
        checked_ms: number;
        gap_ms: number | null;
        progress: string | null;
        rereads: number;
        rows_added: number;
        rows_corrected: number;
        rows_removed: number;
        repaired_ms: number | null;
      }>
    >(
      `SELECT day::text AS day, provider_txs, provider_spam, provider_bridge, our_txs, our_spam, our_bridge, status,
              (extract(epoch FROM checked_at) * 1000)::float8 AS checked_ms,
              (extract(epoch FROM gap_since) * 1000)::float8 AS gap_ms,
              progress, rereads, rows_added, rows_corrected, rows_removed,
              (extract(epoch FROM repaired_at) * 1000)::float8 AS repaired_ms
       FROM elysium_day_check WHERE day >= $1::date ORDER BY day`,
      sinceDay
    );
    return rows.map((r) => ({
      day: r.day.slice(0, 10),
      provider: { txs: Number(r.provider_txs), spam: Number(r.provider_spam), bridge: Number(r.provider_bridge) },
      ours: { txs: Number(r.our_txs), spam: Number(r.our_spam), bridge: Number(r.our_bridge) },
      status: r.status as DayCheckStatus,
      checkedAt: new Date(Number(r.checked_ms)),
      gapSince: r.gap_ms === null ? null : new Date(Number(r.gap_ms)),
      progress: r.progress,
      rereads: Number(r.rereads),
      rowsAdded: Number(r.rows_added),
      rowsCorrected: Number(r.rows_corrected),
      rowsRemoved: Number(r.rows_removed),
      repairedAt: r.repaired_ms === null ? null : new Date(Number(r.repaired_ms)),
    }));
  }

  /**
   * Records a comparison. `gap_since` is set the first time a day differs and kept while it
   * does; a day found equal again loses it. The re-read counters are left as they are.
   */
  public async saveComparison(day: string, provider: DayCounts, ours: DayCounts, status: DayCheckStatus): Promise<void> {
    assertDay(day);
    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_day_check (day, provider_txs, provider_spam, provider_bridge, our_txs, our_spam, our_bridge,
         status, checked_at, gap_since)
       VALUES ($1::date, $2::int, $3::int, $4::int, $5::int, $6::int, $7::int, $8::text, now(),
         CASE WHEN $8::text = 'ok' THEN NULL ELSE now() END)
       ON CONFLICT (day) DO UPDATE SET
         provider_txs = EXCLUDED.provider_txs, provider_spam = EXCLUDED.provider_spam, provider_bridge = EXCLUDED.provider_bridge,
         our_txs = EXCLUDED.our_txs, our_spam = EXCLUDED.our_spam, our_bridge = EXCLUDED.our_bridge,
         status = EXCLUDED.status, checked_at = now(),
         gap_since = CASE WHEN EXCLUDED.status = 'ok' THEN NULL ELSE COALESCE(elysium_day_check.gap_since, now()) END,
         progress = CASE WHEN EXCLUDED.status IN ('ok', 'gap') THEN NULL ELSE elysium_day_check.progress END`,
      day,
      provider.txs,
      provider.spam,
      provider.bridge,
      ours.txs,
      ours.spam,
      ours.bridge,
      status
    );
  }

  /** Records where the re-read of a day stands, and adds what the last slots did to its counters. */
  public async saveProgress(
    day: string,
    patch: { status: DayCheckStatus; progress: string | null; ours?: DayCounts; added: number; corrected: number; removed: number; wholeReread?: boolean }
  ): Promise<void> {
    assertDay(day);
    await prismaHistorical.$executeRawUnsafe(
      `UPDATE elysium_day_check SET
         status = $2::text, progress = $3::text, checked_at = now(),
         our_txs = COALESCE($4::int, our_txs), our_spam = COALESCE($5::int, our_spam), our_bridge = COALESCE($6::int, our_bridge),
         rows_added = rows_added + $7::int, rows_corrected = rows_corrected + $8::int, rows_removed = rows_removed + $9::int,
         rereads = rereads + CASE WHEN $10::boolean THEN 1 ELSE 0 END,
         gap_since = CASE WHEN $2::text = 'ok' THEN NULL ELSE gap_since END,
         repaired_at = CASE WHEN $2::text = 'ok' THEN now() ELSE repaired_at END
       WHERE day = $1::date`,
      day,
      patch.status,
      patch.progress,
      patch.ours?.txs ?? null,
      patch.ours?.spam ?? null,
      patch.ours?.bridge ?? null,
      patch.added,
      patch.corrected,
      patch.removed,
      patch.wholeReread ?? false
    );
  }

  /**
   * Brings the rows we hold in line with what the provider says of them now: the spam flag (the
   * provider classifies after the fact), the outcome, the block a transaction sits in (a chain
   * reorganisation puts the same transaction in another block, sometimes another day), and the
   * gas of a row first read before its receipt was there (stored as 0). Returns how many rows
   * changed. The counts of the senders concerned follow, and the days concerned are marked for
   * their rollups to be rebuilt.
   *
   * The stream's insert leaves a row it already holds as it is (ON CONFLICT DO NOTHING): it had
   * no way to apply any of this.
   */
  public async applyTxFlags(rows: TxRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${FIX_TIMEOUT_MS}`);
        const changed = await tx.$queryRawUnsafe<
          Array<{ from_addr: string; old_day: string; new_day: string; old_at: string; new_at: string; was_user: boolean; is_user: boolean }>
        >(
          `WITH src AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
               tx_hash text, block_number bigint, block_time timestamptz, gas_used bigint, fee_wei numeric,
               success boolean, is_spam boolean)
           ),
           old AS (
             SELECT t.tx_hash, t.block_time, (${IS_USER_SQL}) AS was_user
             FROM elysium_tx t JOIN src s ON s.tx_hash = t.tx_hash
             WHERE t.is_spam IS DISTINCT FROM s.is_spam OR t.success IS DISTINCT FROM s.success
                OR t.block_number IS DISTINCT FROM s.block_number OR t.block_time IS DISTINCT FROM s.block_time
                OR (t.gas_used = 0 AND s.gas_used > 0)
           ),
           upd AS (
             UPDATE elysium_tx t SET
               is_spam = s.is_spam,
               success = s.success,
               block_number = s.block_number,
               block_time = s.block_time,
               -- Never the other way round: a known gas figure is not replaced by a missing one.
               gas_used = CASE WHEN t.gas_used = 0 AND s.gas_used > 0 THEN s.gas_used ELSE t.gas_used END,
               fee_wei = CASE WHEN t.gas_used = 0 AND s.gas_used > 0 THEN s.fee_wei ELSE t.fee_wei END
             FROM src s
             WHERE t.tx_hash = s.tx_hash AND t.tx_hash IN (SELECT tx_hash FROM old)
             RETURNING t.tx_hash, t.from_addr, t.block_time, (${IS_USER_SQL}) AS is_user
           )
           SELECT u.from_addr,
                  ((o.block_time AT TIME ZONE 'UTC')::date)::text AS old_day,
                  ((u.block_time AT TIME ZONE 'UTC')::date)::text AS new_day,
                  to_char(o.block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS old_at,
                  to_char(u.block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS new_at,
                  o.was_user, u.is_user
           FROM upd u JOIN old o ON o.tx_hash = u.tx_hash`,
          JSON.stringify(
            rows.map((r) => ({
              tx_hash: r.tx_hash,
              block_number: r.block_number,
              block_time: r.block_time,
              gas_used: r.gas_used,
              fee_wei: r.fee_wei,
              success: r.success,
              is_spam: r.is_spam,
            }))
          )
        );
        if (changed.length === 0) return 0;
        const events: SenderEvent[] = [];
        for (const c of changed) {
          // Nothing of the sender's counts moves when the row is a user transaction of the same time before and after.
          if (c.was_user === c.is_user && c.old_at === c.new_at) continue;
          if (c.was_user) events.push({ from_addr: c.from_addr, kind: 'leave', day: c.old_day.slice(0, 10), at: c.old_at });
          if (c.is_user) events.push({ from_addr: c.from_addr, kind: 'enter', day: c.new_day.slice(0, 10), at: c.new_at });
        }
        await this.adjustSenders(tx, events);
        await this.markDaysDirty(tx, [...new Set(changed.flatMap((c) => [c.old_day.slice(0, 10), c.new_day.slice(0, 10)]))]);
        return changed.length;
      },
      { timeout: FIX_TIMEOUT_MS + 20_000, maxWait: 15_000 }
    );
  }

  /**
   * Removes transactions the provider no longer lists (the caller has asked it about each one),
   * and everything that was derived from them: their sender's counts, the contract one of them
   * created, the logs read from them (swaps, pools, launch trades, launches), with the market
   * state of the launches whose trades left. Returns how many transactions were removed.
   *
   * This is what a chain reorganisation leaves behind: a transaction read 15 s after its block,
   * then dropped by the chain, stayed here for good.
   */
  public async removeTxs(hashes: string[]): Promise<number> {
    if (hashes.length === 0) return 0;
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${FIX_TIMEOUT_MS}`);
        // The launches whose trades or creation go with these transactions, locked first and in
        // one order, as every writer of a launch's state does.
        const touched = await tx.$queryRawUnsafe<Array<{ token: string }>>(
          `SELECT token FROM elysium_launch
           WHERE token IN (SELECT token FROM elysium_launch_trade WHERE tx_hash = ANY($1::text[]))
              OR tx_hash = ANY($1::text[])
           ORDER BY token FOR UPDATE`,
          hashes
        );
        const gone = await tx.$queryRawUnsafe<Array<{ from_addr: string; day: string; at: string; was_user: boolean }>>(
          `DELETE FROM elysium_tx t WHERE t.tx_hash = ANY($1::text[])
           RETURNING t.from_addr, ((t.block_time AT TIME ZONE 'UTC')::date)::text AS day,
                     to_char(t.block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
                     (${IS_USER_SQL}) AS was_user`,
          hashes
        );
        await tx.$executeRawUnsafe(`DELETE FROM elysium_tx_live WHERE tx_hash = ANY($1::text[])`, hashes);
        // A contract one of them created: gone with it, unless another transaction we hold created it.
        const contracts = await tx.$queryRawUnsafe<Array<{ address: string }>>(
          `DELETE FROM elysium_contract WHERE deploy_tx = ANY($1::text[]) RETURNING address`,
          hashes
        );
        if (contracts.length > 0) {
          await tx.$executeRawUnsafe(
            `INSERT INTO elysium_contract (address, deployer, deploy_tx, deployed_at, block_number)
             SELECT DISTINCT ON (t.contract_address) t.contract_address, t.from_addr, t.tx_hash, t.block_time, t.block_number
             FROM elysium_tx t WHERE t.contract_address = ANY($1::text[])
             ORDER BY t.contract_address, t.block_time
             ON CONFLICT (address) DO NOTHING`,
            contracts.map((c) => c.address)
          );
        }
        await tx.$executeRawUnsafe(`DELETE FROM elysium_dex_swap WHERE tx_hash = ANY($1::text[])`, hashes);
        await tx.$executeRawUnsafe(`DELETE FROM elysium_dex_pool WHERE tx_hash = ANY($1::text[])`, hashes);
        await tx.$executeRawUnsafe(`DELETE FROM elysium_launch_trade WHERE tx_hash = ANY($1::text[])`, hashes);
        await tx.$executeRawUnsafe(`DELETE FROM elysium_launch WHERE tx_hash = ANY($1::text[])`, hashes);
        const tokens = touched.map((t) => t.token);
        if (tokens.length > 0) {
          // The market state of these launches, exactly, from the trades that are left.
          await tx.$executeRawUnsafe(
            `WITH scope AS (SELECT unnest($1::text[]) AS token),
             newest AS (
               SELECT s.token, x.price, x.block_number, x.log_index
               FROM scope s
               LEFT JOIN LATERAL (
                 SELECT tr.price, tr.block_number, tr.log_index FROM elysium_launch_trade tr
                 WHERE tr.token = s.token AND tr.price > 0
                 ORDER BY tr.block_time DESC, tr.block_number DESC, tr.log_index DESC LIMIT 1
               ) x ON true
             ),
             sold AS (
               SELECT tr.token, sum(CASE WHEN tr.is_buy THEN tr.token_amount ELSE -tr.token_amount END) AS sold
               FROM elysium_launch_trade tr
               WHERE tr.venue = 'curve' AND tr.token IN (SELECT token FROM scope)
               GROUP BY tr.token
             )
             UPDATE elysium_launch l
             SET last_price = newest.price, last_block = newest.block_number, last_log = newest.log_index,
                 curve_sold = sold.sold
             FROM newest LEFT JOIN sold ON sold.token = newest.token
             WHERE l.token = newest.token`,
            tokens
          );
        }
        await this.adjustSenders(
          tx,
          gone.filter((g) => g.was_user).map((g) => ({ from_addr: g.from_addr, kind: 'leave' as const, day: g.day.slice(0, 10), at: g.at }))
        );
        await this.markDaysDirty(tx, [...new Set(gone.map((g) => g.day.slice(0, 10)))]);
        return gone.length;
      },
      { timeout: FIX_TIMEOUT_MS + 20_000, maxWait: 15_000 }
    );
  }

  /**
   * Moves the per-sender tables by what changed: elysium_address_day by the user transactions
   * that entered or left each (sender, day), elysium_address when a sender's first user
   * transaction left (its next one is then looked up, once) or when one entered before it.
   *
   * By what changed, not by a recount: a sender reclassified as spam after the fact has its
   * rows in every page of the day, and recounting its day and its history for each page was a
   * scan of all its rows each time.
   */
  private async adjustSenders(tx: Tx, events: SenderEvent[]): Promise<void> {
    if (events.length === 0) return;
    const json = JSON.stringify(events);
    await tx.$executeRawUnsafe(
      `WITH ev AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(from_addr text, kind text, day date, at timestamptz)),
       d AS (
         SELECT from_addr, day, sum(CASE kind WHEN 'enter' THEN 1 ELSE -1 END)::int AS delta
         FROM ev GROUP BY from_addr, day
       ),
       up AS (
         INSERT INTO elysium_address_day (address, day, tx_count)
         SELECT from_addr, day, delta FROM d WHERE delta > 0
         ON CONFLICT (address, day) DO UPDATE SET tx_count = elysium_address_day.tx_count + EXCLUDED.tx_count
         RETURNING 1
       ),
       down AS (
         UPDATE elysium_address_day a SET tx_count = a.tx_count + d.delta
         FROM d WHERE d.delta < 0 AND a.address = d.from_addr AND a.day = d.day
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM up) + (SELECT count(*) FROM down)`,
      json
    );
    // A sender left with no user transaction on a day has no row for it.
    await tx.$executeRawUnsafe(
      `DELETE FROM elysium_address_day a
       USING (SELECT DISTINCT from_addr, day FROM jsonb_to_recordset($1::jsonb) AS r(from_addr text, day date)) e
       WHERE a.address = e.from_addr AND a.day = e.day AND a.tx_count <= 0`,
      json
    );
    // The senders whose first user transaction is one of those that left: their next one, from
    // the table (the rows of this transaction are already changed), or no row at all.
    await tx.$executeRawUnsafe(
      `WITH ev AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(from_addr text, kind text, at timestamptz)),
       lost AS (
         SELECT DISTINCT e.from_addr FROM ev e JOIN elysium_address a ON a.address = e.from_addr
         WHERE e.kind = 'leave' AND e.at <= a.first_seen
       ),
       f AS (
         SELECT l.from_addr, (
           SELECT min(t.block_time) FROM elysium_tx t WHERE t.from_addr = l.from_addr AND ${IS_USER_SQL}
         ) AS first
         FROM lost l
       ),
       del AS (DELETE FROM elysium_address x USING f WHERE x.address = f.from_addr AND f.first IS NULL RETURNING 1),
       upd AS (
         UPDATE elysium_address x SET first_seen = f.first, first_day = (f.first AT TIME ZONE 'UTC')::date
         FROM f WHERE x.address = f.from_addr AND f.first IS NOT NULL AND x.first_seen IS DISTINCT FROM f.first
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM del) + (SELECT count(*) FROM upd)`,
      json
    );
    // The senders with a user transaction that entered before the first one they had, or who had none.
    await tx.$executeRawUnsafe(
      `INSERT INTO elysium_address (address, first_seen, first_day)
       SELECT from_addr, min(at), (min(at) AT TIME ZONE 'UTC')::date
       FROM jsonb_to_recordset($1::jsonb) AS r(from_addr text, kind text, at timestamptz)
       WHERE kind = 'enter' GROUP BY from_addr
       ON CONFLICT (address) DO UPDATE SET first_seen = EXCLUDED.first_seen, first_day = EXCLUDED.first_day
         WHERE EXCLUDED.first_seen < elysium_address.first_seen`,
      json
    );
  }

  /** The rollups of a day that is over are rebuilt once its rows changed (as the tx insert does). */
  private async markDaysDirty(tx: Tx, days: string[]): Promise<void> {
    if (days.length === 0) return;
    await tx.$executeRawUnsafe(
      `INSERT INTO elysium_day_rollup (day, dirty)
       SELECT d::date, true FROM unnest($1::text[]) AS d
       WHERE d::date < (now() AT TIME ZONE 'UTC')::date
       ON CONFLICT (day) DO UPDATE SET dirty = true WHERE NOT elysium_day_rollup.dirty`,
      days
    );
  }
}
