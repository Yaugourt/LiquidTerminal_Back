import { Prisma } from '../../../prisma-historical/generated/client';
import { prismaHistorical } from '../../core/prisma.historical.service';
import { BasePrismaRepository } from './base-prisma.repository';
import {
  HistoricalLiquidationRepository,
  HistoricalChartWindow,
  HistoricalStatsWindow,
} from '../interfaces/historical.repository.interface';
import { RawLiquidationCreateInput, IngestionStateResponse, HistoricalStats, RawChartBucket } from '../../types/historical.types';
import { Liquidation } from '../../types/liquidations.types';

/** A raw_liquidations row as read back for the API (bigint columns as bigint). */
interface EventRow {
  tid: bigint;
  time_ms: bigint;
  coin: string;
  hash: string;
  liquidated_user: string;
  size_total: number;
  notional_total: number;
  fill_px_vwap: number | null;
  mark_px: number;
  method: string;
  fee_total_liquidated: number;
  liquidators: string[] | null;
  liquidator_count: number;
  liq_dir: string | null;
}

/** Same shape as HypeDexer's liquidation rows; `time` in ISO UTC. */
function toLiquidation(row: EventRow): Liquidation {
  const timeMs = Number(row.time_ms);
  return {
    time: new Date(timeMs).toISOString(),
    time_ms: timeMs,
    coin: row.coin,
    hash: row.hash,
    liquidated_user: row.liquidated_user,
    size_total: row.size_total,
    notional_total: row.notional_total,
    fill_px_vwap: row.fill_px_vwap,
    mark_px: row.mark_px,
    method: row.method,
    fee_total_liquidated: row.fee_total_liquidated,
    liquidators: row.liquidators ?? [],
    liquidator_count: row.liquidator_count,
    liq_dir: row.liq_dir === 'Long' || row.liq_dir === 'Short' ? row.liq_dir : null,
    tid: Number(row.tid),
  };
}

/** One row of the stats queries: plain numbers (SUM/MAX of numerics cast to float8, NULL on no rows). */
interface StatsRow {
  liquidations_count: number;
  total_volume: number | null;
  max_liq: number | null;
  long_count: number;
  long_volume: number | null;
  short_count: number;
  short_volume: number | null;
  top_coin: string | null;
  top_coin_volume: number | null;
}

/**
 * Same figures and rounding as the former aggregate + two groupBy version.
 * `notional_total` is DOUBLE PRECISION in the database (init migration —
 * schema.prisma says Decimal): summing per coin first can move the last bit
 * of a float sum, which the rounding to the cent absorbs.
 */
function toHistoricalStats(row: StatsRow | undefined): HistoricalStats {
  const totalVolume = row?.total_volume ?? 0;
  const liquidationsCount = row?.liquidations_count ?? 0;
  const maxLiq = row?.max_liq ?? 0;
  const longVolume = row?.long_volume ?? 0;
  const shortVolume = row?.short_volume ?? 0;
  const topCoinVolume = row?.top_coin_volume ?? 0;

  const avgSize = liquidationsCount > 0
    ? Math.round((totalVolume / liquidationsCount) * 100) / 100
    : 0;

  return {
    totalVolume_USD: Math.round(totalVolume * 100) / 100,
    liquidationsCount,
    longCount: row?.long_count ?? 0,
    shortCount: row?.short_count ?? 0,
    longVolume_USD: Math.round(longVolume * 100) / 100,
    shortVolume_USD: Math.round(shortVolume * 100) / 100,
    topCoin: row?.top_coin ?? 'N/A',
    topCoinVolume_USD: Math.round(topCoinVolume * 100) / 100,
    avgSize_USD: avgSize,
    maxLiq_USD: Math.round(maxLiq * 100) / 100,
  };
}

function earliestSince(windows: { since: Date }[]): Date {
  return new Date(Math.min(...windows.map((w) => w.since.getTime())));
}

/**
 * The liquidations of a window, one row per liquidation — (hash, liquidated
 * user, coin) — with the columns the stats and charts read.
 *
 * Liquidator-only rows are left out: since 2026-09 HypeDexer sends, next to a
 * priced liquidation, rows that only list its liquidators (no direction, zero
 * size and notional). They stay as raw data but are not liquidations. A priced
 * row without a resolved direction (spot backstop liquidations, e.g. @107)
 * is a liquidation: it counts in the totals, not in the long/short split.
 *
 * HypeDexer also lists some liquidations several times under different tids
 * (its WS and REST disagree on tids): growing partial aggregates up to
 * 2026-09, and since then cross-coin merges with an absurd fill price (AVAX
 * at 1.53 for a mark of 11.18). The version kept is the largest whose VWAP
 * lies within 10 % of the liquidation's mark — the smallest mark_px of its
 * versions, as the corrupt ones are sums of marks — else the closest one.
 * Checked against Hyperliquid's own fills for 269 duplicated liquidations:
 * the notional kept was right every time. The key is only compared for
 * equality, so it is sorted bytewise whatever the database collation.
 */
function liquidationEvents(since: Date, coinFilter: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`
    SELECT time, coin, liq_dir, notional_total, tid
    FROM (
      SELECT
        time, coin, liq_dir, notional_total, tid,
        row_number() OVER (
          PARTITION BY hash COLLATE "C", liquidated_user COLLATE "C", coin COLLATE "C"
          ORDER BY
            vwap_deviation <= 0.1 DESC,
            CASE WHEN vwap_deviation <= 0.1 THEN notional_total END DESC NULLS LAST,
            vwap_deviation,
            tid DESC
        ) AS version_rank
      FROM (
        SELECT
          time, coin, liq_dir, notional_total, tid, hash, liquidated_user,
          COALESCE(
            abs(fill_px_vwap / NULLIF(min(mark_px) OVER (
              PARTITION BY hash COLLATE "C", liquidated_user COLLATE "C", coin COLLATE "C"
            ), 0) - 1),
            'Infinity'
          ) AS vwap_deviation
        FROM raw_liquidations
        WHERE time >= ${since} AND (liq_dir IS NOT NULL OR notional_total > 0) ${coinFilter}
      ) versions
    ) ranked
    WHERE version_rank = 1
  `;
}

/**
 * Prisma implementation of the HistoricalLiquidationRepository.
 * Uses prismaHistorical (separate DB) instead of the default prisma client.
 *
 * Stats and charts count each liquidation once: see liquidationEvents().
 */
export class PrismaHistoricalLiquidationRepository
  extends BasePrismaRepository
  implements HistoricalLiquidationRepository
{
  // Override: default client is the historical database, not the main one
  protected prismaClient: any = prismaHistorical;

  /**
   * Override: resetPrismaClient resets to historical DB, not main DB
   */
  resetPrismaClient(): void {
    this.prismaClient = prismaHistorical;
  }

  async createMany(data: RawLiquidationCreateInput[]): Promise<{ count: number }> {
    return this.executeWithErrorHandling(
      async () => {
        return this.prismaClient.rawLiquidation.createMany({
          data,
          skipDuplicates: true,
        });
      },
      'batch insert raw liquidations',
      { count: data.length },
      { verboseSuccess: false }
    );
  }

  async count(): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        return this.prismaClient.rawLiquidation.count();
      },
      'counting raw liquidations'
    );
  }

  async upsertIngestionState(lastTid: bigint, lastTimeMs: bigint, newCount: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.ingestionState.upsert({
          where: { id: 1 },
          update: {
            lastTid,
            lastTimeMs,
            totalIngested: { increment: BigInt(newCount) },
            lastError: null,
          },
          create: {
            id: 1,
            lastTid,
            lastTimeMs,
            totalIngested: BigInt(newCount),
          },
        });
      },
      'upserting ingestion state',
      { lastTid: Number(lastTid), newCount },
      { verboseSuccess: false }
    );
  }

  async getIngestionState(): Promise<IngestionStateResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return this.prismaClient.ingestionState.findUnique({
          where: { id: 1 },
        });
      },
      'reading ingestion state'
    );
  }

  /**
   * One statement and one scan of the window: per-coin aggregates first, then
   * everything (totals, long/short split, top coin) derived from that small
   * set. Replaces an aggregate + two groupBy, i.e. three scans on three pool
   * connections.
   */
  async getStats(since: Date, coin?: string): Promise<HistoricalStats> {
    return this.executeWithErrorHandling(
      async () => {
        const coinFilter = coin ? Prisma.sql`AND coin = ${coin}` : Prisma.empty;
        const rows: StatsRow[] = await this.prismaClient.$queryRaw`
          WITH per_coin AS (
            SELECT
              coin,
              COUNT(*) AS n,
              SUM(notional_total) AS volume,
              MAX(notional_total) AS max_liq,
              COUNT(*) FILTER (WHERE liq_dir = 'Long') AS long_n,
              SUM(notional_total) FILTER (WHERE liq_dir = 'Long') AS long_volume,
              COUNT(*) FILTER (WHERE liq_dir = 'Short') AS short_n,
              SUM(notional_total) FILTER (WHERE liq_dir = 'Short') AS short_volume
            FROM (${liquidationEvents(since, coinFilter)}) liq
            GROUP BY coin
          )
          SELECT
            COALESCE(SUM(n), 0)::int AS liquidations_count,
            SUM(volume)::float8 AS total_volume,
            MAX(max_liq)::float8 AS max_liq,
            COALESCE(SUM(long_n), 0)::int AS long_count,
            SUM(long_volume)::float8 AS long_volume,
            COALESCE(SUM(short_n), 0)::int AS short_count,
            SUM(short_volume)::float8 AS short_volume,
            (SELECT coin FROM per_coin ORDER BY volume DESC, coin LIMIT 1) AS top_coin,
            (SELECT volume::float8 FROM per_coin ORDER BY volume DESC, coin LIMIT 1) AS top_coin_volume
          FROM per_coin
        `;
        return toHistoricalStats(rows[0]);
      },
      'computing historical stats',
      { since: since.toISOString(), coin }
    );
  }

  /**
   * `getStats` for several windows in one statement: the widest window is
   * read once into a CTE, then each window aggregates its own slice of it.
   * Every requested key is present in the result.
   */
  async getStatsForPeriods(windows: HistoricalStatsWindow[]): Promise<Map<string, HistoricalStats>> {
    return this.executeWithErrorHandling(
      async () => {
        const result = new Map<string, HistoricalStats>();
        if (windows.length === 0) return result;

        const perWindow = windows.map((w) => Prisma.sql`
          SELECT
            ${w.key}::text AS period,
            coin,
            COUNT(*) AS n,
            SUM(notional_total) AS volume,
            MAX(notional_total) AS max_liq,
            COUNT(*) FILTER (WHERE liq_dir = 'Long') AS long_n,
            SUM(notional_total) FILTER (WHERE liq_dir = 'Long') AS long_volume,
            COUNT(*) FILTER (WHERE liq_dir = 'Short') AS short_n,
            SUM(notional_total) FILTER (WHERE liq_dir = 'Short') AS short_volume
          FROM w
          WHERE time >= ${w.since}
          GROUP BY coin
        `);
        const rows: (StatsRow & { period: string })[] = await this.prismaClient.$queryRaw`
          WITH w AS MATERIALIZED (
            ${liquidationEvents(earliestSince(windows))}
          ),
          per_coin AS (
            ${Prisma.join(perWindow, ' UNION ALL ')}
          ),
          top AS (
            SELECT DISTINCT ON (period) period, coin, volume
            FROM per_coin
            ORDER BY period, volume DESC, coin
          )
          SELECT
            a.period,
            a.liquidations_count,
            a.total_volume,
            a.max_liq,
            a.long_count,
            a.long_volume,
            a.short_count,
            a.short_volume,
            top.coin AS top_coin,
            top.volume::float8 AS top_coin_volume
          FROM (
            SELECT
              period,
              COALESCE(SUM(n), 0)::int AS liquidations_count,
              SUM(volume)::float8 AS total_volume,
              MAX(max_liq)::float8 AS max_liq,
              COALESCE(SUM(long_n), 0)::int AS long_count,
              SUM(long_volume)::float8 AS long_volume,
              COALESCE(SUM(short_n), 0)::int AS short_count,
              SUM(short_volume)::float8 AS short_volume
            FROM per_coin
            GROUP BY period
          ) a
          LEFT JOIN top ON top.period = a.period
        `;

        const byPeriod = new Map(rows.map((row) => [row.period, row]));
        for (const w of windows) {
          result.set(w.key, toHistoricalStats(byPeriod.get(w.key)));
        }
        return result;
      },
      'computing historical stats for periods',
      { periods: windows.map((w) => w.key).join(',') },
      { verboseSuccess: false }
    );
  }

  async getChart(since: Date, bucketSizeMinutes: number, coin?: string): Promise<RawChartBucket[]> {
    return this.executeWithErrorHandling(
      async () => {
        const bucketSeconds = bucketSizeMinutes * 60;
        // Only filter on coin when one is given: a `(coin IS NULL OR coin = $x)`
        // predicate can't use the (coin, time) index.
        const coinFilter = coin ? Prisma.sql`AND coin = ${coin}` : Prisma.empty;
        return this.prismaClient.$queryRaw<RawChartBucket[]>`
          SELECT
            (to_timestamp(floor(EXTRACT(EPOCH FROM time AT TIME ZONE 'UTC') / ${bucketSeconds}) * ${bucketSeconds}) AT TIME ZONE 'UTC') AS bucket,
            SUM(notional_total)::float AS total_volume,
            COUNT(*)::int AS total_count,
            SUM(CASE WHEN liq_dir = 'Long'  THEN notional_total ELSE 0 END)::float AS long_volume,
            SUM(CASE WHEN liq_dir = 'Short' THEN notional_total ELSE 0 END)::float AS short_volume,
            COUNT(CASE WHEN liq_dir = 'Long'  THEN 1 END)::int AS long_count,
            COUNT(CASE WHEN liq_dir = 'Short' THEN 1 END)::int AS short_count
          FROM (${liquidationEvents(since, coinFilter)}) liq
          GROUP BY 1
          ORDER BY 1 ASC
        `;
      },
      'computing chart buckets',
      { since: since.toISOString(), bucketSizeMinutes, coin }
    );
  }

  /**
   * `getChart` for several windows (each with its own bucket size) in one
   * statement: the widest window is read once into a CTE — with the epoch
   * computed once per row — then each window buckets its own slice of it.
   * Buckets come back in ascending order per key; a key without rows maps to
   * an empty array.
   */
  async getChartForPeriods(windows: HistoricalChartWindow[]): Promise<Map<string, RawChartBucket[]>> {
    return this.executeWithErrorHandling(
      async () => {
        const result = new Map<string, RawChartBucket[]>(windows.map((w) => [w.key, []]));
        if (windows.length === 0) return result;

        // Same buckets as getChart's `floor(EXTRACT(EPOCH …) / s) * s`: the
        // epoch has millisecond precision, far above float8 rounding, so the
        // floor is identical — without numeric arithmetic on every row.
        const perWindow = windows.map((w) => {
          const bucketSeconds = w.bucketSizeMinutes * 60;
          return Prisma.sql`
            SELECT
              ${w.key}::text AS period,
              (to_timestamp(floor(epoch / ${bucketSeconds}::int) * ${bucketSeconds}::int) AT TIME ZONE 'UTC') AS bucket,
              SUM(notional_total)::float AS total_volume,
              COUNT(*)::int AS total_count,
              SUM(CASE WHEN liq_dir = 'Long'  THEN notional_total ELSE 0 END)::float AS long_volume,
              SUM(CASE WHEN liq_dir = 'Short' THEN notional_total ELSE 0 END)::float AS short_volume,
              COUNT(CASE WHEN liq_dir = 'Long'  THEN 1 END)::int AS long_count,
              COUNT(CASE WHEN liq_dir = 'Short' THEN 1 END)::int AS short_count
            FROM w
            WHERE time >= ${w.since}
            GROUP BY 2
          `;
        });
        const rows: (RawChartBucket & { period: string })[] = await this.prismaClient.$queryRaw`
          WITH w AS MATERIALIZED (
            SELECT time, liq_dir, notional_total, date_part('epoch', time) AS epoch
            FROM (${liquidationEvents(earliestSince(windows))}) liq
          )
          ${Prisma.join(perWindow, ' UNION ALL ')}
          ORDER BY 1, 2
        `;

        for (const { period, ...bucket } of rows) {
          result.get(period)?.push(bucket);
        }
        return result;
      },
      'computing chart buckets for periods',
      { periods: windows.map((w) => w.key).join(',') },
      { verboseSuccess: false }
    );
  }

  /**
   * The largest liquidations since `since` (at least `minNotional` USD), one
   * row per liquidation like the stats (see liquidationEvents()), largest
   * first.
   */
  async getTopEvents(since: Date, minNotional: number, limit: number): Promise<Liquidation[]> {
    return this.executeWithErrorHandling(
      async () => {
        const rows: EventRow[] = await this.prismaClient.$queryRaw`
          SELECT
            r.tid, r.time_ms, r.coin, r.hash, r.liquidated_user, r.size_total,
            r.notional_total, r.fill_px_vwap, r.mark_px, r.method,
            r.fee_total_liquidated, r.liquidators, r.liquidator_count, r.liq_dir
          FROM (
            SELECT tid, notional_total
            FROM (${liquidationEvents(since)}) liq
            WHERE notional_total >= ${minNotional}
            ORDER BY notional_total DESC, tid DESC
            LIMIT ${limit}
          ) top
          JOIN raw_liquidations r ON r.tid = top.tid
          ORDER BY top.notional_total DESC, top.tid DESC
        `;
        return rows.map(toLiquidation);
      },
      'reading top liquidations',
      { since: since.toISOString(), minNotional, limit },
      { verboseSuccess: false }
    );
  }
}
