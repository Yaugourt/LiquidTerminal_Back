import { prismaHistorical } from '../../core/prisma.historical.service';
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

function assertDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Elysium check: invalid day');
}

/**
 * The daily comparison of elysium_tx with the provider's own figures, and the statements that
 * put a day right: flags the provider changed since the row was first read, rows the provider
 * no longer lists. Rows the provider lists and we lack go through the stream's own insert.
 *
 * The per-address tables (elysium_address_day, elysium_address) are maintained by that insert
 * from the rows it adds. A row that changes or leaves afterwards is not something an increment
 * can follow, so here they are recomputed, exactly, from elysium_tx, for the senders concerned.
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
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ txs: number; spam: number; bridge: number }>>(
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
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ slot: number; txs: number; spam: number; bridge: number }>>(
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
   * provider classifies after the fact), the outcome, and the gas of a row first read before its
   * receipt was there (stored as 0). Returns how many rows changed. The senders of the rows
   * whose spam flag changed are recounted, and the days concerned are marked for their rollups
   * to be rebuilt.
   *
   * The stream's insert leaves a row it already holds as it is (ON CONFLICT DO NOTHING): it had
   * no way to apply any of this.
   */
  public async applyTxFlags(rows: TxRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${FIX_TIMEOUT_MS}`);
        const changed = await tx.$queryRawUnsafe<Array<{ from_addr: string; day: string; spam_changed: boolean }>>(
          `WITH src AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
               tx_hash text, gas_used bigint, fee_wei numeric, success boolean, is_spam boolean)
           ),
           old AS (
             SELECT t.tx_hash, t.is_spam FROM elysium_tx t JOIN src s ON s.tx_hash = t.tx_hash
             WHERE t.is_spam IS DISTINCT FROM s.is_spam OR t.success IS DISTINCT FROM s.success
                OR (t.gas_used = 0 AND s.gas_used > 0)
           ),
           upd AS (
             UPDATE elysium_tx t SET
               is_spam = s.is_spam,
               success = s.success,
               -- Never the other way round: a known gas figure is not replaced by a missing one.
               gas_used = CASE WHEN t.gas_used = 0 AND s.gas_used > 0 THEN s.gas_used ELSE t.gas_used END,
               fee_wei = CASE WHEN t.gas_used = 0 AND s.gas_used > 0 THEN s.fee_wei ELSE t.fee_wei END
             FROM src s
             WHERE t.tx_hash = s.tx_hash AND t.tx_hash IN (SELECT tx_hash FROM old)
             RETURNING t.tx_hash, t.from_addr, (t.block_time AT TIME ZONE 'UTC')::date AS day
           )
           SELECT u.from_addr, u.day::text AS day, (o.is_spam IS DISTINCT FROM s.is_spam) AS spam_changed
           FROM upd u JOIN old o ON o.tx_hash = u.tx_hash JOIN src s ON s.tx_hash = u.tx_hash`,
          JSON.stringify(rows.map((r) => ({ tx_hash: r.tx_hash, gas_used: r.gas_used, fee_wei: r.fee_wei, success: r.success, is_spam: r.is_spam })))
        );
        if (changed.length === 0) return 0;
        await this.recountSenders(
          tx,
          changed.filter((c) => c.spam_changed).map((c) => ({ from_addr: c.from_addr, day: c.day.slice(0, 10) }))
        );
        await this.markDaysDirty(tx, [...new Set(changed.map((c) => c.day.slice(0, 10)))]);
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
        const gone = await tx.$queryRawUnsafe<Array<{ from_addr: string; day: string }>>(
          `DELETE FROM elysium_tx WHERE tx_hash = ANY($1::text[])
           RETURNING from_addr, ((block_time AT TIME ZONE 'UTC')::date)::text AS day`,
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
        const traded = await tx.$queryRawUnsafe<Array<{ token: string }>>(
          `DELETE FROM elysium_launch_trade WHERE tx_hash = ANY($1::text[]) RETURNING token`,
          hashes
        );
        await tx.$executeRawUnsafe(`DELETE FROM elysium_launch WHERE tx_hash = ANY($1::text[])`, hashes);
        const tokens = [...new Set(traded.map((t) => t.token))];
        if (tokens.length > 0) {
          // The market state of these launches, exactly, from the trades that are left.
          await tx.$executeRawUnsafe(
            `WITH scope AS (SELECT unnest($1::text[]) AS token),
             newest AS (
               SELECT s.token, x.price, x.block_number, x.log_index
               FROM scope s
               LEFT JOIN LATERAL (
                 SELECT tr.price, tr.block_number, tr.log_index FROM elysium_launch_trade tr
                 WHERE tr.token = s.token
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
        await this.recountSenders(tx, gone.map((g) => ({ from_addr: g.from_addr, day: g.day.slice(0, 10) })));
        await this.markDaysDirty(tx, [...new Set(gone.map((g) => g.day.slice(0, 10)))]);
        return gone.length;
      },
      { timeout: FIX_TIMEOUT_MS + 20_000, maxWait: 15_000 }
    );
  }

  /**
   * Recounts, from elysium_tx, the user transactions of each (sender, day) given and the first
   * user transaction of each sender: what elysium_address_day and elysium_address hold. A sender
   * left with no user transaction on a day, or at all, loses its row.
   */
  private async recountSenders(tx: Tx, pairs: Array<{ from_addr: string; day: string }>): Promise<void> {
    if (pairs.length === 0) return;
    const json = JSON.stringify(pairs);
    await tx.$executeRawUnsafe(
      `WITH p AS (SELECT DISTINCT from_addr, day FROM jsonb_to_recordset($1::jsonb) AS r(from_addr text, day date)),
       c AS (
         SELECT p.from_addr, p.day, (
           SELECT count(*) FROM elysium_tx t
           WHERE t.from_addr = p.from_addr
             AND t.block_time >= ((p.day)::timestamp AT TIME ZONE 'UTC')
             AND t.block_time < ((p.day + 1)::timestamp AT TIME ZONE 'UTC')
             AND ${IS_USER_SQL}
         )::int AS n
         FROM p
       ),
       del AS (
         DELETE FROM elysium_address_day d USING c WHERE d.address = c.from_addr AND d.day = c.day AND c.n = 0 RETURNING 1
       ),
       up AS (
         INSERT INTO elysium_address_day (address, day, tx_count)
         SELECT from_addr, day, n FROM c WHERE n > 0
         ON CONFLICT (address, day) DO UPDATE SET tx_count = EXCLUDED.tx_count
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM del) + (SELECT count(*) FROM up)`,
      json
    );
    await tx.$executeRawUnsafe(
      `WITH a AS (SELECT DISTINCT from_addr FROM jsonb_to_recordset($1::jsonb) AS r(from_addr text)),
       f AS (
         SELECT a.from_addr, (
           SELECT min(t.block_time) FROM elysium_tx t WHERE t.from_addr = a.from_addr AND ${IS_USER_SQL}
         ) AS first
         FROM a
       ),
       del AS (DELETE FROM elysium_address x USING f WHERE x.address = f.from_addr AND f.first IS NULL RETURNING 1),
       up AS (
         INSERT INTO elysium_address (address, first_seen, first_day)
         SELECT from_addr, first, (first AT TIME ZONE 'UTC')::date FROM f WHERE first IS NOT NULL
         ON CONFLICT (address) DO UPDATE SET first_seen = EXCLUDED.first_seen, first_day = EXCLUDED.first_day
           WHERE elysium_address.first_seen IS DISTINCT FROM EXCLUDED.first_seen
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM del) + (SELECT count(*) FROM up)`,
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
