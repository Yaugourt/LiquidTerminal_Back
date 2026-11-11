import { prismaHistorical } from '../../core/prisma.historical.service';
import { BRIDGE_TX_TYPES, storableText } from '../../services/elysium/elysium-ingest.util';
import type { BridgeRow, LiveTxRow, TokenRow, TxRow } from '../../services/elysium/elysium-ingest.util';
import type { DexPoolRow, DexSwapRow } from '../../services/elysium/elysium-dex.util';
import type {
  GraduationRow,
  LaunchRow,
  LaunchTradeRow,
} from '../../services/elysium/elysium-launchpad.util';
import type { RejectCount } from '../../services/elysium/elysium-ingest-rejects';

/** Market keys looked up per statement (a page of 1,000 logs names at most 3,000). */
const LAUNCH_MARKET_KEYS_PER_QUERY = 5_000;

/** Time limit of a rebuild of the launch market state (the one-time fill reads every trade). */
const REBUILD_TIMEOUT_MS = 600_000;

/**
 * Limits of the transaction that inserts a page of launch trades. Prisma's own are 2 s to get a
 * connection and 5 s in all: a page that waits for a rebuild of its launches' state, or for a
 * connection of a busy pool, must not fail on them.
 */
const INSERT_TRADES_LIMITS = { timeout: 60_000, maxWait: 15_000 };

/** Constant SQL list of the bridge tx types (no user input involved). */
const BRIDGE_TYPES_SQL = BRIDGE_TX_TYPES.map((t) => `'${t}'`).join(', ');

export type ElysiumStream =
  | 'tx'
  | 'txlive'
  | 'bridge'
  | 'tokens'
  | 'dex'
  | 'methods'
  | 'tokenstats'
  | 'launchpad'
  | 'launchstats'
  /** Not a stream of its own: the marker of the one-time rebuild of the launch market state. */
  | 'launchstate'
  /** Not a stream of its own: the marker of the one-time re-read of the Kiln graduations (`rows` = launches marked). */
  | 'kilngrads'
  /** Not a stream of its own: where the walk through the old executed withdrawals stands (`rows` = days back of the next slice). */
  | 'bridgedeep'
  /** Not a stream of its own: where the walk through the tail of the token listing stands (`rows` = next page). */
  | 'tokenstail'
  /** Not a stream of its own: the builder of the day rollups (only its last error is kept here). */
  | 'rollup'
  /** Not a stream of its own: the daily comparison with the provider (only its last error is kept here; its days are in elysium_day_check). */
  | 'check';

/** Rows of elysium_ingest_state that are markers, not streams: left out of the public status. */
export const ELYSIUM_STATE_MARKERS: ReadonlySet<string> = new Set(['launchstate', 'kilngrads', 'bridgedeep', 'tokenstail', 'rollup', 'check']);

export interface LaunchMarketDbRow {
  token: string;
  launchpad: string;
  kind: string;
  curve: string | null;
  pool: string | null;
  quote: string;
}

export interface LaunchStatsTarget {
  token: string;
  creator: string | null;
  curve: string | null;
  pool: string | null;
  /** A launch read for the first time that has no symbol yet (its event carries none). */
  needsName?: boolean;
}

export interface ElysiumIngestStateRow {
  stream: string;
  cursor: Date | null;
  rows: bigint;
  backfillDone: boolean;
  lastError: string | null;
  updatedAt: Date;
}

/**
 * Write side of the Elysium tables (historical DB). Every statement is an
 * idempotent upsert: replaying a window never double counts.
 */
export class ElysiumIngestRepository {
  private static instance: ElysiumIngestRepository;

  public static getInstance(): ElysiumIngestRepository {
    if (!ElysiumIngestRepository.instance) {
      ElysiumIngestRepository.instance = new ElysiumIngestRepository();
    }
    return ElysiumIngestRepository.instance;
  }

  /**
   * Inserts txs and, in the same statement, maintains contracts, first-seen
   * addresses and per-address daily counts (user txs only: non-spam and not a
   * bridge-driven tx type) from the rows that were actually
   * inserted (RETURNING). A replayed row conflicts, is not returned, and so is
   * never counted twice; a crash rolls back the whole statement. A row of a
   * past UTC day also marks that day's rollups as to be rebuilt.
   */
  public async insertTxs(rows: TxRow[]): Promise<{ inserted: number; contracts: number }> {
    if (rows.length === 0) return { inserted: 0, contracts: 0 };
    const result = await prismaHistorical.$queryRawUnsafe<Array<{ inserted: number; contracts: number }>>(
      `
      WITH src AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
          tx_hash text, block_number bigint, block_time timestamptz, from_addr text, to_addr text,
          contract_address text, method_id text, tx_type text, gas_used bigint, fee_wei numeric,
          success boolean, is_spam boolean)
      ),
      ins AS (
        INSERT INTO elysium_tx (tx_hash, block_number, block_time, from_addr, to_addr,
          contract_address, method_id, tx_type, gas_used, fee_wei, success, is_spam)
        SELECT tx_hash, block_number, block_time, from_addr, to_addr,
          contract_address, method_id, tx_type, gas_used, fee_wei, success, is_spam
        FROM src
        ON CONFLICT (tx_hash) DO NOTHING
        RETURNING tx_hash, block_number, block_time, from_addr, contract_address, is_spam,
          (NOT is_spam AND COALESCE(tx_type, '') NOT IN (${BRIDGE_TYPES_SQL})) AS is_user
      ),
      c AS (
        INSERT INTO elysium_contract (address, deployer, deploy_tx, deployed_at, block_number)
        SELECT DISTINCT ON (contract_address) contract_address, from_addr, tx_hash, block_time, block_number
        FROM ins WHERE contract_address IS NOT NULL
        ORDER BY contract_address, block_time
        ON CONFLICT (address) DO NOTHING
        RETURNING 1
      ),
      a AS (
        INSERT INTO elysium_address (address, first_seen, first_day)
        SELECT from_addr, min(block_time), (min(block_time) AT TIME ZONE 'UTC')::date
        FROM ins WHERE is_user GROUP BY from_addr
        ON CONFLICT (address) DO UPDATE
          SET first_seen = EXCLUDED.first_seen, first_day = EXCLUDED.first_day
          WHERE EXCLUDED.first_seen < elysium_address.first_seen
        RETURNING 1
      ),
      d AS (
        INSERT INTO elysium_address_day (address, day, tx_count)
        SELECT from_addr, (block_time AT TIME ZONE 'UTC')::date, count(*)::int
        FROM ins WHERE is_user GROUP BY 1, 2
        ON CONFLICT (address, day) DO UPDATE
          SET tx_count = elysium_address_day.tx_count + EXCLUDED.tx_count
        RETURNING 1
      ),
      r AS (
        -- A transaction of a day that is over: that day's rollups are rebuilt (see
        -- ElysiumRollupRepository.buildDay for why this lives in the insert's own statement).
        INSERT INTO elysium_day_rollup (day, dirty)
        SELECT DISTINCT (block_time AT TIME ZONE 'UTC')::date, true
        FROM ins
        WHERE (block_time AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date
        ON CONFLICT (day) DO UPDATE SET dirty = true WHERE NOT elysium_day_rollup.dirty
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM ins)::int AS inserted,
             (SELECT count(*) FROM c)::int AS contracts,
             (SELECT count(*) FROM a)::int AS addresses,
             (SELECT count(*) FROM d)::int AS address_days,
             (SELECT count(*) FROM r)::int AS rollup_days
      `,
      JSON.stringify(rows)
    );
    return { inserted: result[0]?.inserted ?? 0, contracts: result[0]?.contracts ?? 0 };
  }

  /** Inserts RPC-read calls to the project contracts; a tx already stored is skipped. */
  public async insertLiveTxs(rows: LiveTxRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    return prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_tx_live (tx_hash, block_number, block_time, from_addr, to_addr)
       SELECT tx_hash, block_number, block_time, from_addr, to_addr
       FROM jsonb_to_recordset($1::jsonb) AS r(
         tx_hash text, block_number bigint, block_time timestamptz, from_addr text, to_addr text)
       ON CONFLICT (tx_hash) DO NOTHING`,
      JSON.stringify(rows)
    );
  }

  /** Drops RPC-read calls the provider's own tx stream has covered for a while. */
  public async pruneLiveTxs(before: Date): Promise<number> {
    return prismaHistorical.$executeRawUnsafe(
      `DELETE FROM elysium_tx_live WHERE block_time < $1::timestamptz`,
      before.toISOString()
    );
  }

  /** Upserts bridge transfers; only rows whose tracked fields changed are rewritten. */
  public async upsertBridgeTransfers(rows: BridgeRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await prismaHistorical.$queryRawUnsafe<Array<{ n: number }>>(
      `
      WITH up AS (
        INSERT INTO elysium_bridge_transfer (transfer_id, direction, asset, route, status, symbol,
          decimals, from_addr, to_addr, amount, l1_tx_hash, l2_tx_hash, initiated_at, completed_at,
          duration_s, updated_at)
        SELECT transfer_id, direction, asset, route, status, symbol, decimals, from_addr, to_addr,
          amount, l1_tx_hash, l2_tx_hash, initiated_at, completed_at, duration_s, now()
        FROM jsonb_to_recordset($1::jsonb) AS r(
          transfer_id text, direction text, asset text, route text, status text, symbol text,
          decimals int, from_addr text, to_addr text, amount numeric, l1_tx_hash text,
          l2_tx_hash text, initiated_at timestamptz, completed_at timestamptz, duration_s float8)
        ON CONFLICT (transfer_id) DO UPDATE SET
          status = EXCLUDED.status,
          symbol = EXCLUDED.symbol,
          decimals = EXCLUDED.decimals,
          from_addr = EXCLUDED.from_addr,
          to_addr = EXCLUDED.to_addr,
          amount = EXCLUDED.amount,
          l1_tx_hash = EXCLUDED.l1_tx_hash,
          l2_tx_hash = EXCLUDED.l2_tx_hash,
          completed_at = EXCLUDED.completed_at,
          duration_s = EXCLUDED.duration_s,
          updated_at = now()
        WHERE (elysium_bridge_transfer.status, elysium_bridge_transfer.completed_at,
               elysium_bridge_transfer.l1_tx_hash, elysium_bridge_transfer.l2_tx_hash,
               elysium_bridge_transfer.amount, elysium_bridge_transfer.duration_s)
          IS DISTINCT FROM
              (EXCLUDED.status, EXCLUDED.completed_at, EXCLUDED.l1_tx_hash, EXCLUDED.l2_tx_hash,
               EXCLUDED.amount, EXCLUDED.duration_s)
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM up
      `,
      JSON.stringify(rows)
    );
    return result[0]?.n ?? 0;
  }

  /**
   * The deposits still waiting for their retryable ticket that the live windows no longer
   * cover (older than `minAgeS`) and that can still change (younger than `maxAgeS`: a ticket is
   * redeemed or expires within 7 days), oldest first, with the hash to read each again by.
   * `offset` lets the caller walk through them when there are more than `limit`.
   */
  public async listOpenDeposits(
    minAgeS: number,
    maxAgeS: number,
    limit: number,
    offset = 0
  ): Promise<Array<{ transfer_id: string; tx_hash: string }>> {
    return prismaHistorical.$queryRawUnsafe<Array<{ transfer_id: string; tx_hash: string }>>(
      `SELECT transfer_id, COALESCE(l1_tx_hash, l2_tx_hash) AS tx_hash
       FROM elysium_bridge_transfer
       WHERE direction = 'deposit' AND status IN ('initiated', 'ticket_created', 'redeem_failed')
         AND initiated_at < now() - make_interval(secs => $1::int)
         AND initiated_at >= now() - make_interval(secs => $2::int)
         -- A hash stored before hashes were checked for their shape cannot be asked for.
         AND COALESCE(l1_tx_hash, l2_tx_hash) ~ '^0x[0-9a-f]{64}$'
       ORDER BY initiated_at, transfer_id
       LIMIT $3::int OFFSET $4::int`,
      minAgeS,
      maxAgeS,
      limit,
      offset
    );
  }

  /**
   * When the newest bridge transfer we hold began: the bridge stream's cursor (the data's own
   * time). Read through the index on initiated_at, and returned as epoch so that the session's
   * time zone cannot shift it.
   */
  public async newestBridgeTransferAt(): Promise<Date | null> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ ms: number | null }>>(
      `SELECT (extract(epoch FROM max(initiated_at)) * 1000)::float8 AS ms FROM elysium_bridge_transfer`
    );
    const ms = rows[0]?.ms;
    return ms === null || ms === undefined ? null : new Date(Number(ms));
  }

  /**
   * Upserts a page of the token registry and returns how many rows it wrote. A row that says
   * what the registry already holds is left alone: most of a page is unchanged from one run to
   * the next, and rewriting it was 200,000 dead rows a run for nothing.
   */
  public async upsertTokens(rows: TokenRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await prismaHistorical.$queryRawUnsafe<Array<{ n: number }>>(
      `
      WITH up AS (
        INSERT INTO elysium_token (address, standard, name, symbol, decimals, origin, first_seen,
          transfer_count, updated_at)
        SELECT address, standard, name, symbol, decimals, origin, first_seen, transfer_count, now()
        FROM jsonb_to_recordset($1::jsonb) AS r(
          address text, standard text, name text, symbol text, decimals int, origin text,
          first_seen timestamptz, transfer_count bigint)
        ON CONFLICT (address) DO UPDATE SET
          standard = EXCLUDED.standard,
          name = EXCLUDED.name,
          symbol = EXCLUDED.symbol,
          decimals = EXCLUDED.decimals,
          origin = EXCLUDED.origin,
          first_seen = COALESCE(elysium_token.first_seen, EXCLUDED.first_seen),
          transfer_count = EXCLUDED.transfer_count,
          updated_at = now()
        WHERE (elysium_token.standard, elysium_token.name, elysium_token.symbol, elysium_token.decimals,
               elysium_token.origin, elysium_token.transfer_count)
            IS DISTINCT FROM
              (EXCLUDED.standard, EXCLUDED.name, EXCLUDED.symbol, EXCLUDED.decimals,
               EXCLUDED.origin, EXCLUDED.transfer_count)
           OR (elysium_token.first_seen IS NULL AND EXCLUDED.first_seen IS NOT NULL)
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM up
      `,
      JSON.stringify(rows)
    );
    return result[0]?.n ?? 0;
  }

  /**
   * Launches whose event carries no name (Signal, aka.fun) take the registry's, so the launchpad
   * search finds them by symbol. Only rows still without one are written. A statement of its own,
   * run after the registry upsert: it writes rows of elysium_launch that the trade inserts and
   * the holder stats write too, and a lock it loses there must not undo a registry page.
   */
  public async nameLaunches(rows: TokenRow[]): Promise<number> {
    const named = rows.filter((r) => r.symbol !== null || r.name !== null);
    if (named.length === 0) return 0;
    return prismaHistorical.$executeRawUnsafe(
      `UPDATE elysium_launch l
       SET symbol = COALESCE(l.symbol, r.symbol), name = COALESCE(l.name, r.name)
       FROM jsonb_to_recordset($1::jsonb) AS r(address text, name text, symbol text)
       WHERE l.token = r.address
         AND ((l.symbol IS NULL AND r.symbol IS NOT NULL) OR (l.name IS NULL AND r.name IS NOT NULL))`,
      JSON.stringify(named.map((r) => ({ address: r.address, name: r.name, symbol: r.symbol })))
    );
  }

  /** Inserts DEX pools (a pool address is created once, so conflicts are ignored). */
  public async insertDexPools(rows: DexPoolRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await prismaHistorical.$queryRawUnsafe<Array<{ n: number }>>(
      `
      WITH ins AS (
        INSERT INTO elysium_dex_pool (pool, factory, version, token0, token1, fee, created_at,
          block_number, tx_hash)
        SELECT pool, factory, version, token0, token1, fee, created_at, block_number, tx_hash
        FROM jsonb_to_recordset($1::jsonb) AS r(
          pool text, factory text, version text, token0 text, token1 text, fee int,
          created_at timestamptz, block_number bigint, tx_hash text)
        ON CONFLICT (pool) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM ins
      `,
      JSON.stringify(rows)
    );
    return result[0]?.n ?? 0;
  }

  /** Inserts swap logs, keyed by (tx_hash, log_index). */
  public async insertDexSwaps(rows: DexSwapRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await prismaHistorical.$queryRawUnsafe<Array<{ n: number }>>(
      `
      WITH ins AS (
        INSERT INTO elysium_dex_swap (tx_hash, log_index, pool, version, block_time, block_number,
          sender, recipient, amount0, amount1)
        SELECT tx_hash, log_index, pool, version, block_time, block_number, sender, recipient,
          amount0, amount1
        FROM jsonb_to_recordset($1::jsonb) AS r(
          tx_hash text, log_index int, pool text, version text, block_time timestamptz,
          block_number bigint, sender text, recipient text, amount0 numeric, amount1 numeric)
        ON CONFLICT (tx_hash, log_index) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM ins
      `,
      JSON.stringify(rows)
    );
    return result[0]?.n ?? 0;
  }

  /**
   * The `limit` most frequent called selectors (contract creations and plain
   * transfers excluded) that were never looked up, or whose last lookup found
   * nothing and is older than `retryAfterS`.
   *
   * Frequency is counted over the last 30 built rollup days plus every
   * transaction after the last built day. It used to be a count over the whole
   * transaction table every 30 minutes; the ranking only picks which selectors
   * are worth a lookup, and a selector named once stays named. With no rollup
   * day built yet, the raw part covers everything, as before.
   */
  public async listUnresolvedMethods(limit: number, retryAfterS: number): Promise<string[]> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ method_id: string }>>(
      `
      WITH built AS (
        SELECT day FROM elysium_day_rollup WHERE built_at IS NOT NULL AND NOT dirty
      ),
      top AS (
        SELECT method_id, sum(n) AS n FROM (
          SELECT d.method_id, sum(d.txs)::bigint AS n
          FROM elysium_call_day d
          WHERE d.day IN (SELECT day FROM built)
            AND d.day >= (SELECT max(day) FROM built) - 29
            AND d.method_id ~ '^0x[0-9a-f]{8}$'
          GROUP BY d.method_id
          UNION ALL
          SELECT t.method_id, count(*)::bigint
          FROM elysium_tx t
          WHERE t.block_time >= COALESCE(
                  (SELECT ((max(day) + 1)::timestamp AT TIME ZONE 'UTC') FROM built),
                  '-infinity'::timestamptz)
            AND t.method_id ~ '^0x[0-9a-f]{8}$' AND t.to_addr IS NOT NULL
          GROUP BY t.method_id
        ) u
        GROUP BY method_id ORDER BY n DESC, method_id LIMIT $1::int
      )
      SELECT top.method_id FROM top
      LEFT JOIN elysium_method_sig s ON s.method_id = top.method_id
      WHERE s.method_id IS NULL
         OR (s.signature IS NULL AND s.resolved_at < now() - make_interval(secs => $2::int))
      ORDER BY top.n DESC
      `,
      limit,
      retryAfterS
    );
    return rows.map((r) => r.method_id);
  }

  public async upsertMethodSigs(
    rows: Array<{ method_id: string; signature: string | null; candidates: number; source: string }>
  ): Promise<number> {
    if (rows.length === 0) return 0;
    return prismaHistorical.$executeRawUnsafe(
      `
      INSERT INTO elysium_method_sig (method_id, signature, candidates, source, resolved_at)
      SELECT method_id, signature, candidates, source, now()
      FROM jsonb_to_recordset($1::jsonb) AS r(method_id text, signature text, candidates int, source text)
      ON CONFLICT (method_id) DO UPDATE SET
        signature = EXCLUDED.signature, candidates = EXCLUDED.candidates,
        source = EXCLUDED.source, resolved_at = now()
      `,
      JSON.stringify(rows)
    );
  }

  /**
   * Tokens whose holder snapshot should be refreshed: the `perList` most
   * transferred named ERC-20s overall and among those first seen in the last
   * 24h, when their snapshot is missing or older than `maxAgeS`.
   */
  public async listTokensForStats(perList: number, maxAgeS: number): Promise<string[]> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ address: string }>>(
      `
      WITH pick AS (
        (SELECT address FROM elysium_token WHERE symbol IS NOT NULL AND standard = 'erc20'
         ORDER BY transfer_count DESC, address LIMIT $1::int)
        UNION
        (SELECT address FROM elysium_token WHERE symbol IS NOT NULL AND standard = 'erc20'
           AND first_seen >= now() - interval '24 hours'
         ORDER BY transfer_count DESC, address LIMIT $1::int)
      )
      SELECT pick.address FROM pick
      LEFT JOIN elysium_token_stat s ON s.address = pick.address
      WHERE s.address IS NULL OR s.fetched_at < now() - make_interval(secs => $2::int)
      -- The ones never read, then the oldest snapshot first: a run cut short resumes where it matters.
      ORDER BY s.fetched_at NULLS FIRST, pick.address
      `,
      perList,
      maxAgeS
    );
    return rows.map((r) => r.address);
  }

  public async upsertTokenStat(address: string, holders: number, totalSupply: string | null): Promise<void> {
    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_token_stat (address, holders, total_supply, fetched_at)
       VALUES ($1::text, $2::int, $3::numeric, now())
       ON CONFLICT (address) DO UPDATE SET holders = EXCLUDED.holders,
         total_supply = EXCLUDED.total_supply, fetched_at = now()`,
      address,
      holders,
      totalSupply
    );
  }

  /**
   * Timestamps cross the driver as ISO text / epoch millis on purpose: the
   * Prisma pg adapter writes Date values as zone-less wall clock, which a
   * non-UTC database session would then misread.
   */
  private async selectStates(stream: ElysiumStream | null): Promise<ElysiumIngestStateRow[]> {
    const rows = await prismaHistorical.$queryRawUnsafe<
      Array<{
        stream: string;
        cursor_ms: number | null;
        rows: string;
        backfill_done: boolean;
        last_error: string | null;
        updated_ms: number;
      }>
    >(
      `SELECT stream, (extract(epoch FROM cursor) * 1000)::float8 AS cursor_ms, rows::text AS rows,
              backfill_done, last_error, (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms
       FROM elysium_ingest_state
       WHERE $1::text IS NULL OR stream = $1::text
       ORDER BY stream`,
      stream
    );
    return rows.map((r) => ({
      stream: r.stream,
      cursor: r.cursor_ms === null ? null : new Date(Number(r.cursor_ms)),
      rows: BigInt(r.rows),
      backfillDone: r.backfill_done,
      lastError: r.last_error,
      updatedAt: new Date(Number(r.updated_ms)),
    }));
  }

  public async getState(stream: ElysiumStream): Promise<ElysiumIngestStateRow | null> {
    return (await this.selectStates(stream))[0] ?? null;
  }

  public async listStates(): Promise<ElysiumIngestStateRow[]> {
    return this.selectStates(null);
  }

  /**
   * Advances the watermark after a fully ingested window and clears the last
   * error. `addRows` increments the counter, `setRows` replaces it. A cursor
   * never moves back: of two writers of one stream (two processes while a
   * deploy overlaps, or with Redis down), the one that is behind leaves the
   * cursor where the other put it.
   */
  public async advance(
    stream: ElysiumStream,
    patch: { cursor?: Date; addRows?: number; setRows?: number; backfillDone?: boolean }
  ): Promise<void> {
    const rows = String(Math.trunc(patch.setRows ?? patch.addRows ?? 0));
    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_ingest_state (stream, cursor, rows, backfill_done, last_error, updated_at)
       VALUES ($1::text, $2::timestamptz, $3::bigint, COALESCE($4::boolean, false), NULL, now())
       ON CONFLICT (stream) DO UPDATE SET
         cursor = CASE WHEN EXCLUDED.cursor IS NULL THEN elysium_ingest_state.cursor
                       WHEN elysium_ingest_state.cursor IS NULL THEN EXCLUDED.cursor
                       ELSE GREATEST(elysium_ingest_state.cursor, EXCLUDED.cursor) END,
         rows = CASE WHEN $5::boolean THEN EXCLUDED.rows ELSE elysium_ingest_state.rows + EXCLUDED.rows END,
         backfill_done = COALESCE($4::boolean, elysium_ingest_state.backfill_done),
         last_error = NULL,
         updated_at = now()`,
      stream,
      patch.cursor ? patch.cursor.toISOString() : null,
      rows,
      patch.backfillDone ?? null,
      patch.setRows !== undefined
    );
  }

  /** Records the last error without moving the watermark. */
  // ---------------------------------------------------------------------------
  // Launchpads
  // ---------------------------------------------------------------------------

  /** Inserts launched tokens (a token launches once, so conflicts are ignored). */
  public async insertLaunches(rows: LaunchRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await prismaHistorical.$queryRawUnsafe<Array<{ n: number }>>(
      `
      WITH ins AS (
        INSERT INTO elysium_launch (token, launchpad, kind, creator, created_at, block_number, tx_hash,
          curve, pool, quote, name, symbol)
        SELECT token, launchpad, kind, creator, created_at, block_number, tx_hash, curve, pool, quote,
          name, symbol
        FROM jsonb_to_recordset($1::jsonb) AS r(
          token text, launchpad text, kind text, creator text, created_at timestamptz,
          block_number bigint, tx_hash text, curve text, pool text, quote text, name text, symbol text)
        ON CONFLICT (token) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM ins
      `,
      JSON.stringify(rows)
    );
    return result[0]?.n ?? 0;
  }

  /**
   * The launches a set of market keys (contract addresses, V4 pool ids) belongs to, for the trade
   * decoders: whichever of token, curve or pool matches. Three index lookups per batch of keys,
   * where the decoders used to be handed every launch (420,000 rows, read twice per 30 s tick).
   */
  public async findLaunchMarkets(keys: string[]): Promise<LaunchMarketDbRow[]> {
    if (keys.length === 0) return [];
    const rows: LaunchMarketDbRow[] = [];
    for (let i = 0; i < keys.length; i += LAUNCH_MARKET_KEYS_PER_QUERY) {
      const batch = keys.slice(i, i + LAUNCH_MARKET_KEYS_PER_QUERY);
      rows.push(
        ...(await prismaHistorical.$queryRawUnsafe<LaunchMarketDbRow[]>(
          `SELECT token, launchpad, kind, curve, pool, quote FROM elysium_launch
           WHERE token = ANY($1::text[]) OR curve = ANY($1::text[]) OR pool = ANY($1::text[])`,
          batch
        ))
      );
    }
    return rows;
  }

  /**
   * Marks curve launches as graduated (first graduation time wins), matched by curve contract or,
   * for pads that hold every curve (Neuriio), by token; records the pair when the event names it.
   */
  public async markGraduated(rows: GraduationRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    return prismaHistorical.$executeRawUnsafe(
      `
      UPDATE elysium_launch l
      SET graduated_at = coalesce(l.graduated_at, g.graduated_at), pool = coalesce(l.pool, g.pool)
      FROM (
        SELECT curve, token, min(pool) AS pool, min(graduated_at) AS graduated_at
        FROM jsonb_to_recordset($1::jsonb) AS r(curve text, token text, pool text, graduated_at timestamptz)
        GROUP BY curve, token
      ) g
      WHERE ((g.curve IS NOT NULL AND l.curve = g.curve) OR (g.token IS NOT NULL AND l.token = g.token))
        AND (l.graduated_at IS NULL OR (l.pool IS NULL AND g.pool IS NOT NULL))
      `,
      JSON.stringify(rows)
    );
  }

  /**
   * Inserts launchpad trades, keyed by (tx_hash, log_index), and in the same
   * statement moves the market state of their tokens (elysium_launch): the last
   * trade's price and position, and what the curve has sold. Both come from the
   * rows that were actually inserted (RETURNING), so a replayed window changes
   * nothing, and a crash rolls the trades and the state back together.
   */
  public async insertLaunchTrades(rows: LaunchTradeRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const tokens = [...new Set(rows.map((r) => r.token))].sort();
    return prismaHistorical.$transaction(async (tx) => {
      // The launches these trades move are locked first, in one order, as a rebuild of their
      // state does: two writers of the same launches then wait for each other instead of
      // deadlocking (6 deadlocks in 120 rounds of an insert against a rebuild before this,
      // measured on a real Postgres; each one failed a tick).
      await tx.$queryRawUnsafe(`SELECT token FROM elysium_launch WHERE token = ANY($1::text[]) ORDER BY token FOR UPDATE`, tokens);
      const result = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `
      WITH ins AS (
        INSERT INTO elysium_launch_trade (tx_hash, log_index, token, venue, block_time, block_number,
          trader, is_buy, quote_amount, token_amount, price)
        SELECT tx_hash, log_index, token, venue, block_time, block_number, trader, is_buy,
          quote_amount, token_amount, price
        FROM jsonb_to_recordset($1::jsonb) AS r(
          tx_hash text, log_index int, token text, venue text, block_time timestamptz,
          block_number bigint, trader text, is_buy boolean, quote_amount numeric,
          token_amount numeric, price float8)
        ON CONFLICT (tx_hash, log_index) DO NOTHING
        RETURNING token, block_number, log_index, price, venue, is_buy, token_amount
      ),
      newest AS (
        -- A trade without a price (0) is stored, and never becomes the launch's last price.
        SELECT DISTINCT ON (token) token, block_number, log_index, price
        FROM ins WHERE price > 0 ORDER BY token, block_number DESC, log_index DESC
      ),
      sold AS (
        SELECT token, sum(CASE WHEN is_buy THEN token_amount ELSE -token_amount END) AS delta
        FROM ins WHERE venue = 'curve' GROUP BY token
      ),
      state AS (
        -- Every comparison is made against the row being updated (l), not against a second read of
        -- it: when this statement waits for another writer of the same launch (a rebuild of its
        -- state, another process's trades), it goes on from what that writer left, and neither
        -- loses the other's work.
        UPDATE elysium_launch l
        SET curve_sold = CASE WHEN sold.delta IS NULL THEN l.curve_sold
                              ELSE COALESCE(l.curve_sold, 0) + sold.delta END,
            last_price = CASE WHEN n.token IS NOT NULL AND (l.last_block IS NULL OR (n.block_number, n.log_index) > (l.last_block, l.last_log))
                              THEN n.price ELSE l.last_price END,
            last_block = CASE WHEN n.token IS NOT NULL AND (l.last_block IS NULL OR (n.block_number, n.log_index) > (l.last_block, l.last_log))
                              THEN n.block_number ELSE l.last_block END,
            last_log = CASE WHEN n.token IS NOT NULL AND (l.last_block IS NULL OR (n.block_number, n.log_index) > (l.last_block, l.last_log))
                            THEN n.log_index ELSE l.last_log END
        FROM (SELECT token FROM newest UNION SELECT token FROM sold) k
        LEFT JOIN newest n ON n.token = k.token
        LEFT JOIN sold ON sold.token = k.token
        WHERE l.token = k.token
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM ins)::int AS n, (SELECT count(*) FROM state)::int AS moved
        `,
        JSON.stringify(rows)
      );
      return result[0]?.n ?? 0;
    }, INSERT_TRADES_LIMITS);
  }

  /**
   * Recomputes the market state (last trade, curve sold) from elysium_launch_trade, exactly: for
   * every traded token when `since` is null (the one-time fill of the columns), else for the
   * tokens with a trade since then (heals trades a process without the insert above wrote, as
   * the previous release does while a deploy overlaps). Only rows that differ are written.
   *
   * A trade's time follows its block, so the last trade by time is the last by (block, log index),
   * which is what the insert compares. One connection, no parallel workers (the historical
   * Postgres has a small /dev/shm, which parallel plans over the trade table have overflowed)
   * and its own time limit.
   */
  public async rebuildLaunchState(since: Date | null): Promise<number> {
    // The tokens to recompute: every launch, or the ones traded since `since`.
    const scope = since
      ? `SELECT DISTINCT token FROM elysium_launch_trade WHERE block_time >= $1::timestamptz`
      : `SELECT token FROM elysium_launch WHERE $1::timestamptz IS NULL`;
    // An interactive transaction: the settings below are local to it, and Prisma's own
    // transaction time limit (5 s by default) has to be raised with the statement's.
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`);
        await tx.$executeRawUnsafe(`SET LOCAL work_mem = '64MB'`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REBUILD_TIMEOUT_MS}`);
        // The launches concerned are locked first, in one order. A trade insert that touches one
        // of them then waits for this rebuild, and adds its own trades on top of what it wrote:
        // without the lock the rebuild could overwrite the state with a sum computed before those
        // trades were visible, and they were missing until the next rebuild (a deploy overlap).
        await tx.$queryRawUnsafe(
          `WITH scope AS (${scope})
           SELECT count(*)::int AS n FROM (
             SELECT l.token FROM elysium_launch l WHERE l.token IN (SELECT token FROM scope) ORDER BY l.token FOR UPDATE
           ) locked`,
          since ? since.toISOString() : null
        );
        return tx.$executeRawUnsafe(
          `
          WITH scope AS (${scope}),
          newest AS (
            -- One index probe per token (token, block_time), not a sort of the whole trade table.
            -- A trade without a price (0) is never a launch's last price.
            SELECT s.token, x.price, x.block_number, x.log_index
            FROM scope s
            -- LEFT: a launch whose trades all lack a price has no last price, and still has what
            -- its curve sold (a launch without any trade ends as it is, nothing to write).
            LEFT JOIN LATERAL (
              SELECT tr.price, tr.block_number, tr.log_index FROM elysium_launch_trade tr
              WHERE tr.token = s.token AND tr.price > 0
              ORDER BY tr.block_time DESC, tr.block_number DESC, tr.log_index DESC LIMIT 1
            ) x ON true
          ),
          sold AS (
            SELECT tr.token, sum(CASE WHEN tr.is_buy THEN tr.token_amount ELSE -tr.token_amount END) AS sold
            FROM elysium_launch_trade tr
            WHERE tr.venue = 'curve' AND ($1::timestamptz IS NULL OR tr.token IN (SELECT token FROM scope))
            GROUP BY tr.token
          )
          UPDATE elysium_launch l
          SET last_price = newest.price, last_block = newest.block_number, last_log = newest.log_index,
              curve_sold = sold.sold
          FROM newest LEFT JOIN sold ON sold.token = newest.token
          WHERE l.token = newest.token
            AND (l.last_price, l.last_block, l.last_log, l.curve_sold)
                IS DISTINCT FROM (newest.price, newest.block_number, newest.log_index, sold.sold)
          `,
          since ? since.toISOString() : null
        );
      },
      { timeout: REBUILD_TIMEOUT_MS + 20_000, maxWait: 15_000 }
    );
  }

  /** Gives every launch without a name of its own the registry's (see nameLaunches); the one-time fill. */
  public async fillLaunchNames(): Promise<number> {
    return prismaHistorical.$executeRawUnsafe(
      `UPDATE elysium_launch l
       SET symbol = COALESCE(l.symbol, t.symbol), name = COALESCE(l.name, t.name)
       FROM elysium_token t
       WHERE t.address = l.token
         AND ((l.symbol IS NULL AND t.symbol IS NOT NULL) OR (l.name IS NULL AND t.name IS NOT NULL))`
    );
  }

  /**
   * The launches whose holder stats to read next, at most `limit`:
   * 1. the ones never read, newest first (a launch shows its holders soon after it appears);
   * 2. the ones traded over the last 24h whose stats are older than `activeMaxAgeS`, oldest first;
   * 3. everything else older than `quietMaxAgeS`, oldest first.
   * The first two together take at most `priority` of the batch, so the long walk through the
   * quiet launches always moves. The creator falls back to the launch tx sender (Signal curves).
   */
  public async listLaunchesForStats(
    limit: number,
    priority: number,
    activeMaxAgeS: number,
    quietMaxAgeS: number,
    /** Tokens to leave out of this batch (their figures could not be read a moment ago). */
    exclude: string[] = [],
    /** Only launches created up to this time (what the provider has indexed, while it lags); null for all. */
    createdUpTo: Date | null = null
  ): Promise<LaunchStatsTarget[]> {
    return prismaHistorical.$queryRawUnsafe<LaunchStatsTarget[]>(
      `
      WITH first AS (
        SELECT * FROM (
          (SELECT l.token, 0 AS pri, -extract(epoch FROM l.created_at) AS ord
           FROM elysium_launch l WHERE l.stats_at IS NULL AND l.token <> ALL($5::text[])
             AND ($6::timestamptz IS NULL OR l.created_at <= $6::timestamptz)
           ORDER BY l.created_at DESC LIMIT $2::int)
          UNION ALL
          (SELECT l.token, 1 AS pri, extract(epoch FROM l.stats_at) AS ord
           FROM (SELECT DISTINCT token FROM elysium_launch_trade
                 WHERE block_time >= now() - interval '24 hours') a
           JOIN elysium_launch l ON l.token = a.token
           WHERE l.stats_at < now() - make_interval(secs => $3::int) AND l.token <> ALL($5::text[])
             AND ($6::timestamptz IS NULL OR l.created_at <= $6::timestamptz)
           ORDER BY l.stats_at LIMIT $2::int)
        ) p ORDER BY pri, ord LIMIT $2::int
      ),
      picks AS (
        SELECT token, pri, ord FROM first
        UNION ALL
        (SELECT l.token, 2 AS pri, extract(epoch FROM l.stats_at) AS ord
         FROM elysium_launch l
         WHERE l.stats_at < now() - make_interval(secs => $4::int) AND l.token <> ALL($5::text[])
           AND ($6::timestamptz IS NULL OR l.created_at <= $6::timestamptz)
         ORDER BY l.stats_at LIMIT $1::int)
      ),
      best AS (SELECT DISTINCT ON (token) token, pri, ord FROM picks ORDER BY token, pri)
      SELECT l.token, coalesce(l.creator, t.from_addr) AS creator, l.curve, l.pool,
             (l.symbol IS NULL AND l.stats_at IS NULL) AS "needsName"
      FROM best
      JOIN elysium_launch l ON l.token = best.token
      LEFT JOIN elysium_tx t ON t.tx_hash = l.tx_hash AND l.creator IS NULL
      ORDER BY best.pri, best.ord
      LIMIT $1::int
      `,
      limit,
      priority,
      activeMaxAgeS,
      quietMaxAgeS,
      exclude,
      createdUpTo ? createdUpTo.toISOString() : null
    );
  }

  public async updateLaunchStats(token: string, holders: number, top10Pct: number | null, devPct: number | null): Promise<void> {
    await prismaHistorical.$executeRawUnsafe(
      `UPDATE elysium_launch SET holders = $2::int, top10_pct = $3::float8, dev_pct = $4::float8, stats_at = now()
       WHERE token = $1`,
      token,
      holders,
      top10Pct,
      devPct
    );
  }

  /**
   * Adds what a tick left out to the day's counts (see IngestRejects). The first sample of a day
   * stays: it is the one that says when the trouble started.
   */
  public async addRejects(rows: RejectCount[]): Promise<void> {
    if (rows.length === 0) return;
    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_ingest_reject (stream, reason, day, count, last_at, sample)
       SELECT stream, reason, (now() AT TIME ZONE 'UTC')::date, count, now(), sample
       FROM jsonb_to_recordset($1::jsonb) AS r(stream text, reason text, count bigint, sample text)
       ON CONFLICT (stream, reason, day) DO UPDATE SET
         count = elysium_ingest_reject.count + EXCLUDED.count,
         last_at = now(),
         sample = COALESCE(elysium_ingest_reject.sample, EXCLUDED.sample)`,
      JSON.stringify(rows.map((r) => ({ stream: r.stream, reason: r.reason, count: r.count, sample: r.sample === null ? null : storableText(r.sample) })))
    );
  }

  public async recordError(stream: ElysiumStream, message: string): Promise<void> {
    await prismaHistorical.$executeRawUnsafe(
      `INSERT INTO elysium_ingest_state (stream, last_error, updated_at)
       VALUES ($1::text, $2::text, now())
       ON CONFLICT (stream) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now()`,
      stream,
      message.slice(0, 1000)
    );
  }
}
