import { prismaHistorical } from '../../core/prisma.historical.service';
import { BRIDGE_TX_TYPES } from '../../services/elysium/elysium-ingest.util';
import type { BridgeRow, TokenRow, TxRow } from '../../services/elysium/elysium-ingest.util';
import type { DexPoolRow, DexSwapRow } from '../../services/elysium/elysium-dex.util';
import type {
  GraduationRow,
  LaunchRow,
  LaunchTradeRow,
} from '../../services/elysium/elysium-launchpad.util';

/** Constant SQL list of the bridge tx types (no user input involved). */
const BRIDGE_TYPES_SQL = BRIDGE_TX_TYPES.map((t) => `'${t}'`).join(', ');

export type ElysiumStream = 'tx' | 'bridge' | 'tokens' | 'dex' | 'methods' | 'tokenstats' | 'launchpad' | 'launchstats';

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
   * never counted twice; a crash rolls back the whole statement.
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
      )
      SELECT (SELECT count(*) FROM ins)::int AS inserted,
             (SELECT count(*) FROM c)::int AS contracts,
             (SELECT count(*) FROM a)::int AS addresses,
             (SELECT count(*) FROM d)::int AS address_days
      `,
      JSON.stringify(rows)
    );
    return { inserted: result[0]?.inserted ?? 0, contracts: result[0]?.contracts ?? 0 };
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

  /** Upserts the token registry snapshot. */
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
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM up
      `,
      JSON.stringify(rows)
    );
    return result[0]?.n ?? 0;
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
   */
  public async listUnresolvedMethods(limit: number, retryAfterS: number): Promise<string[]> {
    const rows = await prismaHistorical.$queryRawUnsafe<Array<{ method_id: string }>>(
      `
      WITH top AS (
        SELECT method_id, count(*) AS n FROM elysium_tx
        WHERE method_id ~ '^0x[0-9a-f]{8}$' AND to_addr IS NOT NULL
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
   * error. `addRows` increments the counter, `setRows` replaces it.
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
         cursor = COALESCE(EXCLUDED.cursor, elysium_ingest_state.cursor),
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

  /** Every known launch market, for the trade decoders. */
  public async listLaunchMarkets(): Promise<LaunchMarketDbRow[]> {
    return prismaHistorical.$queryRawUnsafe<LaunchMarketDbRow[]>(
      `SELECT token, launchpad, kind, curve, pool, quote FROM elysium_launch`
    );
  }

  /** Marks curve launches as graduated (first graduation time wins). */
  public async markGraduated(rows: GraduationRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    return prismaHistorical.$executeRawUnsafe(
      `
      UPDATE elysium_launch l SET graduated_at = g.graduated_at
      FROM (
        SELECT curve, min(graduated_at) AS graduated_at
        FROM jsonb_to_recordset($1::jsonb) AS r(curve text, graduated_at timestamptz)
        GROUP BY curve
      ) g
      WHERE l.curve = g.curve AND l.graduated_at IS NULL
      `,
      JSON.stringify(rows)
    );
  }

  /** Inserts launchpad trades, keyed by (tx_hash, log_index). */
  public async insertLaunchTrades(rows: LaunchTradeRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await prismaHistorical.$queryRawUnsafe<Array<{ n: number }>>(
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
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM ins
      `,
      JSON.stringify(rows)
    );
    return result[0]?.n ?? 0;
  }

  /**
   * Launches whose holder stats are missing or older than `maxAgeS`, oldest
   * first. The creator falls back to the launch tx sender (Signal curves).
   */
  public async listLaunchesForStats(limit: number, maxAgeS: number): Promise<LaunchStatsTarget[]> {
    return prismaHistorical.$queryRawUnsafe<LaunchStatsTarget[]>(
      `
      SELECT l.token, coalesce(l.creator, t.from_addr) AS creator, l.curve, l.pool
      FROM elysium_launch l
      LEFT JOIN elysium_tx t ON t.tx_hash = l.tx_hash
      WHERE l.stats_at IS NULL OR l.stats_at < now() - make_interval(secs => $2::int)
      ORDER BY l.stats_at ASC NULLS FIRST, l.created_at DESC
      LIMIT $1::int
      `,
      limit,
      maxAgeS
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
