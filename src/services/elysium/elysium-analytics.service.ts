import { prismaHistorical } from '../../core/prisma.historical.service';
import { cacheService } from '../../core/cache.service';
import { ElysiumIngestRepository } from '../../repositories/prisma/prisma.elysium.repository';
import {
  fillDays,
  lastDays,
  precompileLabel,
  PRECOMPILE_LIKE,
  retentionFraction,
  share,
  toDayKey,
} from './elysium-analytics.util';
import { methodName } from './elysium-dex.util';
import { errorCategory } from './elysium-analytics.util';

const CACHE_TTL_S = 60;
/** How long a computed value is kept to be served while it refreshes. */
const KEEP_S = 6 * 3600;
const CACHE_PREFIX = 'elysium:analytics';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
/** Epoch millis (from SQL) -> ISO string. */
const iso = (v: number | null): string | null => (v === null || v === undefined ? null : new Date(Number(v)).toISOString());
/** Timestamps go to SQL as ISO text (see ElysiumIngestRepository on zone handling). */
const ts = (d: Date): string => d.toISOString();

export type ContractsWindow = '24h' | '7d';
export type FeesWindow = '24h' | '7d' | '30d';

/** Address tag rule for "bot-like": this many user txs in the last 24h, or this share of all of them. */
export const BOT_TXS_24H = 500;
export const BOT_SHARE_24H = 0.01;

export interface MethodRef {
  methodId: string;
  signature: string | null;
  name: string | null;
}

/**
 * Elysium analytics computed in SQL over the ingested tables (historical DB).
 * Spam txs are excluded unless a metric says otherwise. Days are UTC and the
 * current day is flagged `partial: true`. Each result is cached 60s in Redis.
 */
export class ElysiumAnalyticsService {
  private static instance: ElysiumAnalyticsService;

  public static getInstance(): ElysiumAnalyticsService {
    if (!ElysiumAnalyticsService.instance) {
      ElysiumAnalyticsService.instance = new ElysiumAnalyticsService();
    }
    return ElysiumAnalyticsService.instance;
  }

  /**
   * Served from the last computed value and refreshed in the background once
   * older than CACHE_TTL_S: the heavier aggregates take seconds over the full
   * tx table, and no visitor should wait for them.
   */
  private cached<T>(name: string, params: string, fn: () => Promise<T>): Promise<T> {
    return cacheService.getOrRefresh<T>(`${CACHE_PREFIX}:${name}:${params}`, fn, CACHE_TTL_S, KEEP_S);
  }

  /** Plain 60s cache for cheap or per-address reads, where a stale answer would mislead. */
  private cachedFresh<T>(name: string, params: string, fn: () => Promise<T>): Promise<T> {
    return cacheService.getOrSet<T>(`${CACHE_PREFIX}:${name}:${params}`, fn, CACHE_TTL_S);
  }

  /**
   * Computes the views the Elysium pages open on, so the first visitor after a
   * deploy does not wait for them. Sequential to keep the DB load flat.
   */
  public async warmDefaults(): Promise<void> {
    const jobs: Array<() => Promise<unknown>> = [
      () => this.getDeployments(14),
      () => this.getContracts('24h'),
      () => this.getContracts('7d'),
      () => this.getUsers(14),
      () => this.getBridge(14),
      () => this.getEconomics(14),
      () => this.getMethods('24h'),
      () => this.getDex(14),
      () => this.getTokens(14),
      () => this.getFees('7d'),
    ];
    for (const job of jobs) {
      try {
        await job();
      } catch {
        // A failed warm-up only means the first visitor computes it.
      }
    }
  }

  /** First day of a `days`-long UTC range ending today. */
  private rangeStart(now: Date, days: number): { keys: string[]; start: Date } {
    const keys = lastDays(now, days);
    return { keys, start: new Date(`${keys[0]}T00:00:00Z`) };
  }

  // ---------------------------------------------------------------------------
  // 1. status
  // ---------------------------------------------------------------------------

  public getStatus(): Promise<{ streams: Array<Record<string, unknown>> }> {
    return this.cachedFresh('status', 'v1', async () => {
      const rows = await ElysiumIngestRepository.getInstance().listStates();
      const now = Date.now();
      return {
        streams: rows.map((r) => ({
          stream: r.stream,
          cursor: r.cursor ? r.cursor.toISOString() : null,
          rows: Number(r.rows),
          backfillDone: r.backfillDone,
          lastError: errorCategory(r.lastError),
          lagSeconds: r.cursor ? Math.max(0, Math.round((now - r.cursor.getTime()) / 1000)) : null,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 2. deployments
  // ---------------------------------------------------------------------------

  public getDeployments(days: number): Promise<unknown> {
    return this.cached('deployments', `d${days}`, async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);
      const since7d = new Date(now.getTime() - 7 * DAY_MS);
      const since24h = new Date(now.getTime() - DAY_MS);

      const [daily, top, trending] = await Promise.all([
        prismaHistorical.$queryRaw<Array<{ day: string; deployments: number; deployers: number }>>`
          SELECT (deployed_at AT TIME ZONE 'UTC')::date::text AS day,
                 count(*)::int AS deployments, count(DISTINCT deployer)::int AS deployers
          FROM elysium_contract WHERE deployed_at >= ${ts(start)}::timestamptz
          GROUP BY 1`,
        prismaHistorical.$queryRaw<
          Array<{ address: string; deployments: number; first_deploy: number; last_deploy: number }>
        >`
          SELECT deployer AS address, count(*)::int AS deployments,
                 (extract(epoch FROM min(deployed_at)) * 1000)::float8 AS first_deploy, (extract(epoch FROM max(deployed_at)) * 1000)::float8 AS last_deploy
          FROM elysium_contract WHERE deployed_at >= ${ts(since7d)}::timestamptz
          GROUP BY deployer ORDER BY deployments DESC, address LIMIT 15`,
        prismaHistorical.$queryRaw<
          Array<{
            address: string;
            deployer: string;
            deployed_at: number;
            callers: number;
            txs: number;
            symbol: string | null;
          }>
        >`
          WITH calls AS (
            SELECT t.to_addr, count(DISTINCT t.from_addr)::int AS callers, count(*)::int AS txs
            FROM elysium_tx t
            JOIN elysium_contract c ON c.address = t.to_addr AND c.deployed_at >= ${ts(since24h)}::timestamptz
            WHERE t.block_time >= ${ts(since24h)}::timestamptz AND NOT t.is_spam
            GROUP BY t.to_addr
          )
          SELECT c.address, c.deployer, (extract(epoch FROM c.deployed_at) * 1000)::float8 AS deployed_at, calls.callers, calls.txs, tk.symbol
          FROM calls
          JOIN elysium_contract c ON c.address = calls.to_addr
          LEFT JOIN elysium_token tk ON tk.address = c.address
          ORDER BY calls.callers DESC, calls.txs DESC, c.address LIMIT 15`,
      ]);

      const byDay = new Map(
        daily.map((r) => [toDayKey(r.day), { deployments: r.deployments, deployers: r.deployers }])
      );
      return {
        daily: fillDays(keys, byDay, () => ({ deployments: 0, deployers: 0 }), now),
        topDeployers: top.map((r) => ({
          address: r.address,
          deployments: r.deployments,
          firstDeploy: iso(r.first_deploy),
          lastDeploy: iso(r.last_deploy),
        })),
        trending: trending.map((r) => ({
          address: r.address,
          deployer: r.deployer,
          deployedAt: iso(r.deployed_at),
          callers24h: r.callers,
          txs24h: r.txs,
          symbol: r.symbol ?? null,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 3. contracts
  // ---------------------------------------------------------------------------

  /**
   * Top 25 called contracts in the window (by non-spam txs), compared with the
   * equal preceding window. Only known contracts are ranked: deployed ones,
   * registry tokens, and 0x0000…00XX precompiles (plain EOA targets excluded).
   */
  public getContracts(window: ContractsWindow): Promise<unknown> {
    return this.cached('contracts', window, async () => {
      const spanMs = window === '7d' ? 7 * DAY_MS : DAY_MS;
      const now = new Date();
      const curStart = new Date(now.getTime() - spanMs);
      const prevStart = new Date(now.getTime() - 2 * spanMs);

      const rows = await prismaHistorical.$queryRaw<
        Array<{
          address: string;
          txs: number;
          callers: number;
          gas_used: string;
          txs_prev: number | null;
          callers_prev: number | null;
          deployer: string | null;
          deployed_at: number | null;
          name: string | null;
          symbol: string | null;
          is_token: boolean;
        }>
      >`
        WITH cur AS (
          SELECT t.to_addr AS address, count(*)::int AS txs,
                 count(DISTINCT t.from_addr)::int AS callers, sum(t.gas_used)::text AS gas_used
          FROM elysium_tx t
          WHERE t.block_time >= ${ts(curStart)}::timestamptz AND t.block_time < ${ts(now)}::timestamptz AND NOT t.is_spam
            AND t.to_addr IS NOT NULL
            AND (t.to_addr LIKE ${PRECOMPILE_LIKE}
                 OR EXISTS (SELECT 1 FROM elysium_contract c WHERE c.address = t.to_addr)
                 OR EXISTS (SELECT 1 FROM elysium_token k WHERE k.address = t.to_addr))
          GROUP BY t.to_addr
          ORDER BY txs DESC, address
          LIMIT 25
        ),
        prev AS (
          SELECT t.to_addr AS address, count(*)::int AS txs, count(DISTINCT t.from_addr)::int AS callers
          FROM elysium_tx t
          WHERE t.to_addr IN (SELECT address FROM cur)
            AND t.block_time >= ${ts(prevStart)}::timestamptz AND t.block_time < ${ts(curStart)}::timestamptz AND NOT t.is_spam
          GROUP BY t.to_addr
        )
        SELECT cur.address, cur.txs, cur.callers, cur.gas_used,
               prev.txs AS txs_prev, prev.callers AS callers_prev,
               c.deployer, (extract(epoch FROM c.deployed_at) * 1000)::float8 AS deployed_at, tk.name, tk.symbol, (tk.address IS NOT NULL) AS is_token
        FROM cur
        LEFT JOIN prev ON prev.address = cur.address
        LEFT JOIN elysium_contract c ON c.address = cur.address
        LEFT JOIN elysium_token tk ON tk.address = cur.address
        ORDER BY cur.txs DESC, cur.address`;

      const addrs = rows.map((r) => r.address);
      const [methodRows, names] = await Promise.all([
        addrs.length
          ? prismaHistorical.$queryRaw<Array<{ address: string; method_id: string | null; txs: number }>>`
              SELECT address, method_id, txs FROM (
                SELECT t.to_addr AS address, t.method_id, count(*)::int AS txs,
                       row_number() OVER (PARTITION BY t.to_addr ORDER BY count(*) DESC, t.method_id) AS rk
                FROM elysium_tx t
                WHERE t.to_addr = ANY(${addrs}::text[])
                  AND t.block_time >= ${ts(curStart)}::timestamptz AND t.block_time < ${ts(now)}::timestamptz
                  AND NOT t.is_spam
                GROUP BY t.to_addr, t.method_id
              ) x WHERE rk <= 3 ORDER BY address, txs DESC`
          : Promise.resolve([]),
        this.methodNames(),
      ]);
      const methodsBy = new Map<string, Array<MethodRef & { txs: number }>>();
      for (const m of methodRows) {
        const list = methodsBy.get(m.address) ?? [];
        list.push({ ...this.methodRef(m.method_id, names), txs: m.txs });
        methodsBy.set(m.address, list);
      }

      return {
        window,
        rows: rows.map((r) => {
          const pre = precompileLabel(r.address);
          const kind = pre ? 'precompile' : r.is_token ? 'token' : 'contract';
          return {
            address: r.address,
            kind,
            label: pre ?? (r.is_token ? r.name : null),
            symbol: r.symbol ?? null,
            deployer: r.deployer ?? null,
            deployedAt: iso(r.deployed_at),
            txs: r.txs,
            callers: r.callers,
            gasUsed: num(r.gas_used),
            txsPrev: r.txs_prev ?? 0,
            callersPrev: r.callers_prev ?? 0,
            topMethods: methodsBy.get(r.address) ?? [],
          };
        }),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 4. users
  // ---------------------------------------------------------------------------

  /**
   * Senders are user txs only: non-spam and not a bridge-driven tx type
   * (0x64/0x68/0x69, sent from aliased L1 addresses).
   */
  public getUsers(days: number): Promise<unknown> {
    return this.cached('users', `d${days}`, async () => {
      const now = new Date();
      const { keys } = this.rangeStart(now, days);
      const startDay = keys[0];
      const since24h = new Date(now.getTime() - DAY_MS);

      const [active, fresh, cohorts, senders] = await Promise.all([
        prismaHistorical.$queryRaw<Array<{ day: string; n: number }>>`
          SELECT day::text AS day, count(*)::int AS n FROM elysium_address_day
          WHERE day >= ${startDay}::date GROUP BY day`,
        prismaHistorical.$queryRaw<Array<{ day: string; n: number }>>`
          SELECT first_day::text AS day, count(*)::int AS n FROM elysium_address
          WHERE first_day >= ${startDay}::date GROUP BY first_day`,
        prismaHistorical.$queryRaw<Array<{ day: string; size: number; d1: number; d7: number }>>`
          SELECT a.first_day::text AS day, count(*)::int AS size,
                 count(d1.address)::int AS d1, count(d7.address)::int AS d7
          FROM elysium_address a
          LEFT JOIN elysium_address_day d1 ON d1.address = a.address AND d1.day = a.first_day + 1
          LEFT JOIN elysium_address_day d7 ON d7.address = a.address AND d7.day = a.first_day + 7
          WHERE a.first_day >= ${startDay}::date
          GROUP BY a.first_day`,
        prismaHistorical.$queryRaw<
          Array<{ address: string; txs: number; targets: number; senders: number; total: number }>
        >`
          WITH s AS (
            SELECT from_addr, count(*)::int AS txs, count(DISTINCT to_addr)::int AS targets
            FROM elysium_tx WHERE block_time >= ${ts(since24h)}::timestamptz AND NOT is_spam
              AND COALESCE(tx_type, '') NOT IN ('0x64', '0x68', '0x69')
            GROUP BY from_addr
          )
          SELECT from_addr AS address, txs, targets,
                 (count(*) OVER ())::int AS senders, (sum(txs) OVER ())::int AS total
          FROM s ORDER BY txs DESC, address LIMIT 15`,
      ]);

      const activeBy = new Map(active.map((r) => [toDayKey(r.day), r.n]));
      const newBy = new Map(fresh.map((r) => [toDayKey(r.day), r.n]));
      const merged = new Map(
        keys.map((k) => {
          const a = activeBy.get(k) ?? 0;
          const n = newBy.get(k) ?? 0;
          return [k, { active: a, new: n, returning: Math.max(0, a - n) }];
        })
      );
      const cohortBy = new Map(cohorts.map((r) => [toDayKey(r.day), r]));
      const totalTxs = senders[0]?.total ?? 0;
      const top10 = senders.slice(0, 10).reduce((s, r) => s + r.txs, 0);

      return {
        daily: fillDays(keys, merged, () => ({ active: 0, new: 0, returning: 0 }), now),
        retention: keys.map((k) => {
          const c = cohortBy.get(k);
          const size = c?.size ?? 0;
          return {
            cohortDay: k,
            size,
            d1: retentionFraction(k, 1, size, c?.d1 ?? 0, now),
            d7: retentionFraction(k, 7, size, c?.d7 ?? 0, now),
          };
        }),
        concentration24h: {
          senders: senders[0]?.senders ?? 0,
          txs: totalTxs,
          top1Share: share(senders[0]?.txs ?? 0, totalTxs),
          top10Share: share(top10, totalTxs),
        },
        topSenders24h: senders.map((r) => ({
          address: r.address,
          txs: r.txs,
          share: share(r.txs, totalTxs),
          distinctTargets: r.targets,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 5. bridge
  // ---------------------------------------------------------------------------

  /**
   * Bridge flows by initiation day. Counts include every status (a withdrawal
   * is counted when initiated); finality uses completed transfers only.
   * HYPE = symbol 'HYPE' on the native route.
   */
  public getBridge(days: number): Promise<unknown> {
    return this.cached('bridge', `d${days}`, async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);

      const [daily, tokens, finality, bridgers] = await Promise.all([
        prismaHistorical.$queryRaw<
          Array<{ day: string; deposits: number; withdrawals: number; hype_in: number; hype_out: number }>
        >`
          SELECT (initiated_at AT TIME ZONE 'UTC')::date::text AS day,
                 count(*) FILTER (WHERE direction = 'deposit')::int AS deposits,
                 count(*) FILTER (WHERE direction = 'withdrawal')::int AS withdrawals,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'deposit' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_in,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'withdrawal' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_out
          FROM elysium_bridge_transfer WHERE initiated_at >= ${ts(start)}::timestamptz
          GROUP BY 1`,
        prismaHistorical.$queryRaw<
          Array<{
            symbol: string | null;
            route: string;
            deposits: number;
            withdrawals: number;
            amount_in: number;
            amount_out: number;
          }>
        >`
          SELECT symbol, route,
                 count(*) FILTER (WHERE direction = 'deposit')::int AS deposits,
                 count(*) FILTER (WHERE direction = 'withdrawal')::int AS withdrawals,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'deposit'), 0)::float8 AS amount_in,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'withdrawal'), 0)::float8 AS amount_out
          FROM elysium_bridge_transfer WHERE initiated_at >= ${ts(start)}::timestamptz
          GROUP BY symbol, route
          ORDER BY count(*) DESC, symbol LIMIT 25`,
        prismaHistorical.$queryRaw<
          Array<{ direction: string; completed: number; median_s: number | null; p90_s: number | null }>
        >`
          SELECT direction, count(*)::int AS completed,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_s) AS median_s,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_s) AS p90_s
          FROM elysium_bridge_transfer
          WHERE initiated_at >= ${ts(start)}::timestamptz AND completed_at IS NOT NULL AND duration_s IS NOT NULL
          GROUP BY direction ORDER BY direction`,
        prismaHistorical.$queryRaw<
          Array<{ address: string; transfers: number; hype_in: number; hype_out: number }>
        >`
          SELECT from_addr AS address, count(*)::int AS transfers,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'deposit' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_in,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'withdrawal' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_out
          FROM elysium_bridge_transfer
          WHERE initiated_at >= ${ts(start)}::timestamptz AND from_addr IS NOT NULL
          GROUP BY from_addr ORDER BY transfers DESC, address LIMIT 30`,
      ]);

      const byDay = new Map(
        daily.map((r) => [
          toDayKey(r.day),
          {
            deposits: r.deposits,
            withdrawals: r.withdrawals,
            hypeIn: num(r.hype_in),
            hypeOut: num(r.hype_out),
            netHype: num(r.hype_in) - num(r.hype_out),
          },
        ])
      );
      return {
        daily: fillDays(
          keys,
          byDay,
          () => ({ deposits: 0, withdrawals: 0, hypeIn: 0, hypeOut: 0, netHype: 0 }),
          now
        ),
        tokens: tokens.map((r) => ({
          symbol: r.symbol,
          route: r.route,
          deposits: r.deposits,
          withdrawals: r.withdrawals,
          amountIn: num(r.amount_in),
          amountOut: num(r.amount_out),
        })),
        finality: finality.map((r) => ({
          direction: r.direction,
          completed: r.completed,
          medianS: r.median_s === null ? null : num(r.median_s),
          p90S: r.p90_s === null ? null : num(r.p90_s),
        })),
        topBridgers: bridgers.map((r) => ({
          address: r.address,
          transfers: r.transfers,
          hypeIn: num(r.hype_in),
          hypeOut: num(r.hype_out),
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 5b. fees by app
  // ---------------------------------------------------------------------------

  /**
   * Gas fees paid to each called contract and each deployer over the window,
   * with their share of all non-spam fees. "Apps" are deployed contracts and
   * registry tokens; precompile calls (bridge retryables, system) are totalled
   * apart as "system" but still listed; plain transfers to EOAs count in the
   * total only. Fees include the parent
   * posting part (fee_wei is the full receipt fee). Cached 5 min (24h), 10 min
   * (7d) and 30 min (30d): the 30d window scans every tx of the month.
   */
  public getFees(window: FeesWindow): Promise<unknown> {
    return cacheService.getOrRefresh(
      `${CACHE_PREFIX}:fees:${window}`,
      async () => {
        const spanMs = (window === '30d' ? 30 : window === '7d' ? 7 : 1) * DAY_MS;
        const now = new Date();
        const start = new Date(now.getTime() - spanMs);
        const prevStart = new Date(now.getTime() - 2 * spanMs);

        const rows = await prismaHistorical.$queryRaw<
          Array<{ kind: string; key: string | null; fees: number; txs: number; gas: string | null; n: number }>
        >`
          WITH f AS (
            SELECT t.to_addr AS address, sum(t.fee_wei) AS fee, count(*)::int AS txs, sum(t.gas_used) AS gas
            FROM elysium_tx t
            WHERE t.block_time >= ${ts(start)}::timestamptz AND t.block_time < ${ts(now)}::timestamptz
              AND NOT t.is_spam AND t.to_addr IS NOT NULL
            GROUP BY t.to_addr
          ),
          k AS (
            SELECT f.*, c.deployer
            FROM f
            LEFT JOIN elysium_contract c ON c.address = f.address
            LEFT JOIN elysium_token tk ON tk.address = f.address
            WHERE f.address LIKE ${PRECOMPILE_LIKE} OR c.address IS NOT NULL OR tk.address IS NOT NULL
          )
          SELECT 'total' AS kind, NULL AS key, (COALESCE(sum(fee), 0) / 1e18)::float8 AS fees,
                 COALESCE(sum(txs), 0)::int AS txs, sum(gas)::text AS gas, count(*)::int AS n FROM f
          UNION ALL
          SELECT 'apps', NULL, (COALESCE(sum(fee), 0) / 1e18)::float8, COALESCE(sum(txs), 0)::int, sum(gas)::text, count(*)::int
          FROM k WHERE address NOT LIKE ${PRECOMPILE_LIKE}
          UNION ALL
          SELECT 'system', NULL, (COALESCE(sum(fee), 0) / 1e18)::float8, COALESCE(sum(txs), 0)::int, sum(gas)::text, count(*)::int
          FROM k WHERE address LIKE ${PRECOMPILE_LIKE}
          UNION ALL
          (SELECT 'contract', address, (fee / 1e18)::float8, txs, gas::text, 1 FROM k ORDER BY fee DESC, address LIMIT 25)
          UNION ALL
          (SELECT 'deployer', deployer, (sum(fee) / 1e18)::float8, sum(txs)::int, sum(gas)::text, count(*)::int
           FROM k WHERE deployer IS NOT NULL GROUP BY deployer ORDER BY sum(fee) DESC, deployer LIMIT 15)`;

        const total = rows.find((r) => r.kind === 'total');
        const apps = rows.find((r) => r.kind === 'apps');
        const system = rows.find((r) => r.kind === 'system');
        const contracts = rows.filter((r) => r.kind === 'contract' && r.key);
        const deployers = rows.filter((r) => r.kind === 'deployer' && r.key);
        const addrs = contracts.map((r) => r.key as string);

        const [meta, prev, callers] = addrs.length
          ? await Promise.all([
              prismaHistorical.$queryRaw<
                Array<{ address: string; deployer: string | null; name: string | null; symbol: string | null; is_token: boolean }>
              >`
                SELECT a.address, c.deployer, tk.name, tk.symbol, (tk.address IS NOT NULL) AS is_token
                FROM unnest(${addrs}::text[]) AS a(address)
                LEFT JOIN elysium_contract c ON c.address = a.address
                LEFT JOIN elysium_token tk ON tk.address = a.address`,
              prismaHistorical.$queryRaw<Array<{ address: string; fees: number }>>`
                SELECT to_addr AS address, (sum(fee_wei) / 1e18)::float8 AS fees FROM elysium_tx
                WHERE to_addr = ANY(${addrs}::text[]) AND NOT is_spam
                  AND block_time >= ${ts(prevStart)}::timestamptz AND block_time < ${ts(start)}::timestamptz
                GROUP BY to_addr`,
              prismaHistorical.$queryRaw<Array<{ address: string; callers: number }>>`
                SELECT to_addr AS address, count(DISTINCT from_addr)::int AS callers FROM elysium_tx
                WHERE to_addr = ANY(${addrs}::text[]) AND NOT is_spam
                  AND block_time >= ${ts(start)}::timestamptz AND block_time < ${ts(now)}::timestamptz
                GROUP BY to_addr`,
            ])
          : [[], [], []];
        const metaBy = new Map(meta.map((m) => [m.address, m]));
        const prevBy = new Map(prev.map((p) => [p.address, num(p.fees)]));
        const callersBy = new Map(callers.map((c) => [c.address, c.callers]));

        const totalFees = num(total?.fees);
        const pct = (v: number) => (totalFees > 0 ? v / totalFees : 0);

        return {
          window,
          from: start.toISOString(),
          to: now.toISOString(),
          totals: {
            feesHype: totalFees,
            txs: total?.txs ?? 0,
            gasUsed: num(total?.gas),
            appFeesHype: num(apps?.fees),
            appTxs: apps?.txs ?? 0,
            appShare: pct(num(apps?.fees)),
            apps: apps?.n ?? 0,
            systemFeesHype: num(system?.fees),
            systemShare: pct(num(system?.fees)),
          },
          contracts: contracts.map((r) => {
            const address = r.key as string;
            const m = metaBy.get(address);
            const pre = precompileLabel(address);
            const fees = num(r.fees);
            return {
              address,
              kind: pre ? 'precompile' : m?.is_token ? 'token' : 'contract',
              label: pre ?? (m?.is_token ? m.name : null),
              symbol: m?.symbol ?? null,
              deployer: m?.deployer ?? null,
              feesHype: fees,
              feesHypePrev: prevBy.get(address) ?? 0,
              share: pct(fees),
              txs: r.txs,
              callers: callersBy.get(address) ?? 0,
              gasUsed: num(r.gas),
              avgFeeHype: r.txs > 0 ? fees / r.txs : 0,
            };
          }),
          deployers: deployers.map((r) => ({
            deployer: r.key as string,
            contracts: r.n,
            feesHype: num(r.fees),
            share: pct(num(r.fees)),
            txs: r.txs,
            gasUsed: num(r.gas),
          })),
        };
      },
      // The window sets the scan size: ~0.5M txs a day, so 30d reads ~15M rows.
      window === '30d' ? 1800 : window === '7d' ? 600 : 300,
      24 * 3600
    );
  }

  // ---------------------------------------------------------------------------
  // 6. economics
  // ---------------------------------------------------------------------------

  /**
   * Daily tx economics. `txs` = non-spam txs, `spamTxs` = spam txs (so the
   * ingested total is txs + spamTxs), `failedTxs` = failed non-spam txs,
   * `bridgeTxs` = the part of `txs` that is bridge-driven (types 0x64/0x68/0x69;
   * txs - bridgeTxs matches the provider's user_transactions).
   * Fees cover ALL ingested txs (spam included), in HYPE (fee_wei / 1e18).
   * `totals.txs` counts every ingested tx (same basis as `totals.feesHype`).
   * No fee split is applied here.
   */
  public getEconomics(days: number): Promise<unknown> {
    return this.cached('economics', `d${days}`, async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);

      const rows = await prismaHistorical.$queryRaw<
        Array<{ day: string; txs: number; spam: number; failed: number; bridge: number; fees: number }>
      >`
        SELECT (block_time AT TIME ZONE 'UTC')::date::text AS day,
               count(*) FILTER (WHERE NOT is_spam)::int AS txs,
               count(*) FILTER (WHERE is_spam)::int AS spam,
               count(*) FILTER (WHERE NOT is_spam AND NOT success)::int AS failed,
               count(*) FILTER (WHERE NOT is_spam AND tx_type IN ('0x64', '0x68', '0x69'))::int AS bridge,
               (COALESCE(sum(fee_wei), 0) / 1e18)::float8 AS fees
        FROM elysium_tx WHERE block_time >= ${ts(start)}::timestamptz
        GROUP BY 1`;

      const byDay = new Map(
        rows.map((r) => {
          const total = r.txs + r.spam;
          const fees = num(r.fees);
          return [
            toDayKey(r.day),
            {
              txs: r.txs,
              spamTxs: r.spam,
              failedTxs: r.failed,
              bridgeTxs: r.bridge,
              feesHype: fees,
              avgFeeHype: total > 0 ? fees / total : 0,
            },
          ];
        })
      );
      const daily = fillDays(
        keys,
        byDay,
        () => ({ txs: 0, spamTxs: 0, failedTxs: 0, bridgeTxs: 0, feesHype: 0, avgFeeHype: 0 }),
        now
      );
      return {
        daily,
        totals: {
          feesHype: daily.reduce((s, d) => s + d.feesHype, 0),
          txs: daily.reduce((s, d) => s + d.txs + d.spamTxs, 0),
        },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 7. method names (selector -> signature)
  // ---------------------------------------------------------------------------

  /** Every resolved selector (top ~200 by frequency), cached 5 min. */
  private methodNames(): Promise<Record<string, string>> {
    return cacheService.getOrSet<Record<string, string>>(
      `${CACHE_PREFIX}:method-names:v1`,
      async () => {
        const rows = await prismaHistorical.$queryRaw<Array<{ method_id: string; signature: string }>>`
          SELECT method_id, signature FROM elysium_method_sig WHERE signature IS NOT NULL`;
        return Object.fromEntries(rows.map((r) => [r.method_id, r.signature]));
      },
      300
    );
  }

  /** `methodId` null = plain value transfer (no calldata). */
  private methodRef(methodId: string | null, names: Record<string, string>): MethodRef {
    const id = methodId ?? '';
    const signature = id ? names[id] ?? null : null;
    return { methodId: id, signature, name: methodName(signature) };
  }

  /**
   * Top 25 called selectors in the window (non-spam calls to an address;
   * contract creations and plain transfers are counted apart), plus the full
   * selector -> signature map so clients can label any tx.
   */
  public getMethods(window: ContractsWindow): Promise<unknown> {
    return this.cached('methods', window, async () => {
      const spanMs = window === '7d' ? 7 * DAY_MS : DAY_MS;
      const now = new Date();
      const start = new Date(now.getTime() - spanMs);
      const [rows, totals, names, resolved] = await Promise.all([
        // Top selectors first, then distinct senders / contracts via two-level
        // hash aggregates (count(DISTINCT) per group sorts and takes ~40s here).
        prismaHistorical.$queryRaw<Array<{ method_id: string; txs: number; senders: number; contracts: number }>>`
          WITH base AS (
            SELECT method_id, from_addr, to_addr FROM elysium_tx
            WHERE block_time >= ${ts(start)}::timestamptz AND block_time < ${ts(now)}::timestamptz
              AND NOT is_spam AND to_addr IS NOT NULL AND method_id IS NOT NULL
          ),
          top AS (SELECT method_id, count(*)::int AS txs FROM base GROUP BY 1 ORDER BY txs DESC, method_id LIMIT 25),
          s AS (
            SELECT method_id, count(*)::int AS n
            FROM (SELECT DISTINCT b.method_id, b.from_addr FROM base b JOIN top USING (method_id)) x GROUP BY 1
          ),
          c AS (
            SELECT method_id, count(*)::int AS n
            FROM (SELECT DISTINCT b.method_id, b.to_addr FROM base b JOIN top USING (method_id)) x GROUP BY 1
          )
          SELECT top.method_id, top.txs, COALESCE(s.n, 0) AS senders, COALESCE(c.n, 0) AS contracts
          FROM top LEFT JOIN s USING (method_id) LEFT JOIN c USING (method_id)
          ORDER BY top.txs DESC, top.method_id`,
        prismaHistorical.$queryRaw<Array<{ calls: number; transfers: number; creations: number }>>`
          SELECT count(*) FILTER (WHERE to_addr IS NOT NULL AND method_id IS NOT NULL)::int AS calls,
                 count(*) FILTER (WHERE to_addr IS NOT NULL AND method_id IS NULL)::int AS transfers,
                 count(*) FILTER (WHERE to_addr IS NULL)::int AS creations
          FROM elysium_tx
          WHERE block_time >= ${ts(start)}::timestamptz AND block_time < ${ts(now)}::timestamptz AND NOT is_spam`,
        this.methodNames(),
        prismaHistorical.$queryRaw<Array<{ looked_up: number; found: number }>>`
          SELECT count(*)::int AS looked_up, count(signature)::int AS found FROM elysium_method_sig`,
      ]);
      const t = totals[0] ?? { calls: 0, transfers: 0, creations: 0 };
      return {
        window,
        totals: { calls: t.calls, plainTransfers: t.transfers, contractCreations: t.creations },
        resolver: { lookedUp: resolved[0]?.looked_up ?? 0, found: resolved[0]?.found ?? 0 },
        rows: rows.map((r) => ({
          ...this.methodRef(r.method_id, names),
          txs: r.txs,
          share: share(r.txs, t.calls),
          senders: r.senders,
          contracts: r.contracts,
        })),
        names,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 8. DEX (Uniswap V2/V3 logs)
  // ---------------------------------------------------------------------------

  /**
   * Pools come from PairCreated / PoolCreated logs (factory = emitting
   * contract), swaps from V2/V3 Swap logs. Traders = distinct tx senders of
   * the swap txs (the log's own `sender` is usually a router), falling back to
   * the log sender when the tx is not indexed.
   */
  public getDex(days: number): Promise<unknown> {
    return this.cached('dex', `d${days}`, async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);
      const since24h = new Date(now.getTime() - DAY_MS);

      const [pools, swaps, factories, top, fresh, totals] = await Promise.all([
        prismaHistorical.$queryRaw<Array<{ day: string; n: number }>>`
          SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n
          FROM elysium_dex_pool WHERE created_at >= ${ts(start)}::timestamptz GROUP BY 1`,
        prismaHistorical.$queryRaw<Array<{ day: string; swaps: number; active: number }>>`
          SELECT (block_time AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS swaps,
                 count(DISTINCT pool)::int AS active
          FROM elysium_dex_swap WHERE block_time >= ${ts(start)}::timestamptz GROUP BY 1`,
        prismaHistorical.$queryRaw<
          Array<{ address: string; versions: string; pools: number; swaps24h: number; last_pool: number }>
        >`
          SELECT p.factory AS address, string_agg(DISTINCT p.version, ',') AS versions,
                 count(DISTINCT p.pool)::int AS pools,
                 (SELECT count(*) FROM elysium_dex_swap s JOIN elysium_dex_pool q ON q.pool = s.pool
                   WHERE q.factory = p.factory AND s.block_time >= ${ts(since24h)}::timestamptz)::int AS swaps24h,
                 (extract(epoch FROM max(p.created_at)) * 1000)::float8 AS last_pool
          FROM elysium_dex_pool p GROUP BY p.factory ORDER BY pools DESC, address LIMIT 15`,
        prismaHistorical.$queryRaw<
          Array<{
            pool: string;
            version: string;
            fee: number | null;
            token0: string | null;
            token1: string | null;
            sym0: string | null;
            sym1: string | null;
            swaps: number;
            traders: number;
          }>
        >`
          SELECT s.pool, s.version, p.fee, p.token0, p.token1, k0.symbol AS sym0, k1.symbol AS sym1,
                 count(*)::int AS swaps, count(DISTINCT COALESCE(t.from_addr, s.sender))::int AS traders
          FROM elysium_dex_swap s
          LEFT JOIN elysium_tx t ON t.tx_hash = s.tx_hash
          LEFT JOIN elysium_dex_pool p ON p.pool = s.pool
          LEFT JOIN elysium_token k0 ON k0.address = p.token0
          LEFT JOIN elysium_token k1 ON k1.address = p.token1
          WHERE s.block_time >= ${ts(since24h)}::timestamptz
          GROUP BY s.pool, s.version, p.fee, p.token0, p.token1, k0.symbol, k1.symbol
          ORDER BY swaps DESC, s.pool LIMIT 15`,
        prismaHistorical.$queryRaw<
          Array<{
            pool: string;
            factory: string;
            version: string;
            fee: number | null;
            token0: string;
            token1: string;
            sym0: string | null;
            sym1: string | null;
            created_at: number;
            swaps: number;
          }>
        >`
          SELECT p.pool, p.factory, p.version, p.fee, p.token0, p.token1, k0.symbol AS sym0, k1.symbol AS sym1,
                 (extract(epoch FROM p.created_at) * 1000)::float8 AS created_at,
                 (SELECT count(*) FROM elysium_dex_swap s
                   WHERE s.pool = p.pool AND s.block_time >= ${ts(since24h)}::timestamptz)::int AS swaps
          FROM elysium_dex_pool p
          LEFT JOIN elysium_token k0 ON k0.address = p.token0
          LEFT JOIN elysium_token k1 ON k1.address = p.token1
          ORDER BY p.created_at DESC, p.pool LIMIT 30`,
        prismaHistorical.$queryRaw<
          Array<{ pools: number; swaps: number; swaps24h: number; traders24h: number; pools24h: number }>
        >`
          SELECT (SELECT count(*) FROM elysium_dex_pool)::int AS pools,
                 (SELECT count(*) FROM elysium_dex_swap)::int AS swaps,
                 (SELECT count(*) FROM elysium_dex_pool WHERE created_at >= ${ts(since24h)}::timestamptz)::int AS pools24h,
                 (SELECT count(*) FROM elysium_dex_swap WHERE block_time >= ${ts(since24h)}::timestamptz)::int AS swaps24h,
                 (SELECT count(DISTINCT COALESCE(t.from_addr, s.sender)) FROM elysium_dex_swap s
                   LEFT JOIN elysium_tx t ON t.tx_hash = s.tx_hash
                   WHERE s.block_time >= ${ts(since24h)}::timestamptz)::int AS traders24h`,
      ]);

      const poolsBy = new Map(pools.map((r) => [toDayKey(r.day), r.n]));
      const swapsBy = new Map(swaps.map((r) => [toDayKey(r.day), r]));
      const merged = new Map(
        keys.map((k) => [
          k,
          { poolsCreated: poolsBy.get(k) ?? 0, swaps: swapsBy.get(k)?.swaps ?? 0, activePools: swapsBy.get(k)?.active ?? 0 },
        ])
      );
      const t = totals[0];
      return {
        totals: {
          pools: t?.pools ?? 0,
          swaps: t?.swaps ?? 0,
          pools24h: t?.pools24h ?? 0,
          swaps24h: t?.swaps24h ?? 0,
          traders24h: t?.traders24h ?? 0,
        },
        daily: fillDays(keys, merged, () => ({ poolsCreated: 0, swaps: 0, activePools: 0 }), now),
        factories: factories.map((r) => ({
          address: r.address,
          versions: r.versions.split(','),
          pools: r.pools,
          swaps24h: r.swaps24h,
          lastPoolAt: iso(r.last_pool),
        })),
        topPools24h: top.map((r) => ({
          pool: r.pool,
          version: r.version,
          fee: r.fee,
          token0: r.token0,
          token1: r.token1,
          token0Symbol: r.sym0,
          token1Symbol: r.sym1,
          swaps24h: r.swaps,
          traders24h: r.traders,
        })),
        newPools: fresh.map((r) => ({
          pool: r.pool,
          factory: r.factory,
          version: r.version,
          fee: r.fee,
          token0: r.token0,
          token1: r.token1,
          token0Symbol: r.sym0,
          token1Symbol: r.sym1,
          pair: r.sym0 && r.sym1 ? `${r.sym0}/${r.sym1}` : null,
          createdAt: iso(r.created_at),
          swaps24h: r.swaps,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 9. token launches (provider token registry + holder snapshots)
  // ---------------------------------------------------------------------------

  /**
   * Launches = ERC-20 registry rows by first_seen day (`launched` all, `named`
   * with a symbol). Ranked lists only show tokens with a symbol; `holders` is
   * the latest /tokens/{address} snapshot (top tokens only, null otherwise).
   */
  public getTokens(days: number): Promise<unknown> {
    return this.cached('tokens', `d${days}`, async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);
      const since24h = new Date(now.getTime() - DAY_MS);

      type TokenOut = {
        address: string;
        name: string | null;
        symbol: string;
        decimals: number | null;
        origin: string | null;
        first_seen: number | null;
        transfers: string;
        holders: number | null;
        holders_at: number | null;
      };

      const [daily, fresh, top, totals] = await Promise.all([
        prismaHistorical.$queryRaw<Array<{ day: string; launched: number; named: number }>>`
          SELECT (first_seen AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS launched,
                 count(*) FILTER (WHERE symbol IS NOT NULL)::int AS named
          FROM elysium_token WHERE standard = 'erc20' AND first_seen >= ${ts(start)}::timestamptz GROUP BY 1`,
        prismaHistorical.$queryRaw<TokenOut[]>`
          SELECT k.address, k.name, k.symbol, k.decimals, k.origin,
                 (extract(epoch FROM k.first_seen) * 1000)::float8 AS first_seen, k.transfer_count::text AS transfers,
                 s.holders, (extract(epoch FROM s.fetched_at) * 1000)::float8 AS holders_at
          FROM elysium_token k LEFT JOIN elysium_token_stat s ON s.address = k.address
          WHERE k.standard = 'erc20' AND k.symbol IS NOT NULL AND k.first_seen >= ${ts(since24h)}::timestamptz
          ORDER BY k.transfer_count DESC, k.address LIMIT 25`,
        prismaHistorical.$queryRaw<TokenOut[]>`
          SELECT k.address, k.name, k.symbol, k.decimals, k.origin,
                 (extract(epoch FROM k.first_seen) * 1000)::float8 AS first_seen, k.transfer_count::text AS transfers,
                 s.holders, (extract(epoch FROM s.fetched_at) * 1000)::float8 AS holders_at
          FROM elysium_token k LEFT JOIN elysium_token_stat s ON s.address = k.address
          WHERE k.standard = 'erc20' AND k.symbol IS NOT NULL
          ORDER BY k.transfer_count DESC, k.address LIMIT 25`,
        prismaHistorical.$queryRaw<Array<{ tokens: number; named: number; launched24h: number; named24h: number }>>`
          SELECT count(*)::int AS tokens, count(*) FILTER (WHERE symbol IS NOT NULL)::int AS named,
                 count(*) FILTER (WHERE first_seen >= ${ts(since24h)}::timestamptz)::int AS launched24h,
                 count(*) FILTER (WHERE first_seen >= ${ts(since24h)}::timestamptz AND symbol IS NOT NULL)::int AS named24h
          FROM elysium_token WHERE standard = 'erc20'`,
      ]);

      const map = (r: TokenOut) => ({
        address: r.address,
        name: r.name,
        symbol: r.symbol,
        decimals: r.decimals,
        origin: r.origin,
        firstSeen: iso(r.first_seen),
        transfers: num(r.transfers),
        holders: r.holders ?? null,
        holdersAt: iso(r.holders_at),
      });
      const byDay = new Map(daily.map((r) => [toDayKey(r.day), { launched: r.launched, named: r.named }]));
      const t = totals[0];
      return {
        totals: {
          tokens: t?.tokens ?? 0,
          named: t?.named ?? 0,
          launched24h: t?.launched24h ?? 0,
          named24h: t?.named24h ?? 0,
        },
        daily: fillDays(keys, byDay, () => ({ launched: 0, named: 0 }), now),
        newTokens24h: fresh.map(map),
        topTokens: top.map(map),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 10. address profile (tags from our tables)
  // ---------------------------------------------------------------------------

  /**
   * Network-wide user txs over 24h. Cached under ONE key: it does not depend on
   * the address, and running it inside every address profile let each fresh
   * address (an unbounded key space) trigger a full 24h count.
   */
  private networkTxs24h(): Promise<number> {
    return this.cached('network-txs-24h', 'v1', async () => {
      const since24h = new Date(Date.now() - DAY_MS);
      const rows = await prismaHistorical.$queryRaw<Array<{ total: number }>>`
        SELECT count(*)::int AS total FROM elysium_tx WHERE block_time >= ${ts(since24h)}::timestamptz
          AND NOT is_spam AND COALESCE(tx_type, '') NOT IN ('0x64', '0x68', '0x69')`;
      return rows[0]?.total ?? 0;
    });
  }

  /** Tags and counts for one address, computed from the ingested tables. */
  public getAddress(address: string): Promise<unknown> {
    const a = address.toLowerCase();
    return this.cachedFresh('address', a, async () => {
      const now = new Date();
      const since24h = new Date(now.getTime() - DAY_MS);
      const [seen, act, net, deploys, dex, bridge, methods, names] = await Promise.all([
        prismaHistorical.$queryRaw<Array<{ first_seen: number }>>`
          SELECT (extract(epoch FROM first_seen) * 1000)::float8 AS first_seen FROM elysium_address WHERE address = ${a}`,
        prismaHistorical.$queryRaw<Array<{ txs: number; days: number; txs24h: number }>>`
          SELECT COALESCE(sum(tx_count), 0)::int AS txs, count(*)::int AS days,
                 (SELECT count(*) FROM elysium_tx WHERE from_addr = ${a} AND block_time >= ${ts(since24h)}::timestamptz
                   AND NOT is_spam AND COALESCE(tx_type, '') NOT IN ('0x64', '0x68', '0x69'))::int AS txs24h
          FROM elysium_address_day WHERE address = ${a}`,
        this.networkTxs24h(),
        prismaHistorical.$queryRaw<Array<{ n: number; last: number | null }>>`
          SELECT count(*)::int AS n, (extract(epoch FROM max(deployed_at)) * 1000)::float8 AS last
          FROM elysium_contract WHERE deployer = ${a}`,
        prismaHistorical.$queryRaw<Array<{ swaps: number; pools: number; swaps24h: number }>>`
          SELECT count(*)::int AS swaps, count(DISTINCT s.pool)::int AS pools,
                 count(*) FILTER (WHERE s.block_time >= ${ts(since24h)}::timestamptz)::int AS swaps24h
          FROM elysium_dex_swap s JOIN elysium_tx t ON t.tx_hash = s.tx_hash WHERE t.from_addr = ${a}`,
        prismaHistorical.$queryRaw<
          Array<{ deposits: number; withdrawals: number; hype_in: number; hype_out: number }>
        >`
          SELECT count(*) FILTER (WHERE direction = 'deposit')::int AS deposits,
                 count(*) FILTER (WHERE direction = 'withdrawal')::int AS withdrawals,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'deposit' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_in,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'withdrawal' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_out
          FROM elysium_bridge_transfer WHERE from_addr = ${a} OR to_addr = ${a}`,
        prismaHistorical.$queryRaw<Array<{ method_id: string | null; to_null: boolean; txs: number }>>`
          SELECT CASE WHEN to_addr IS NULL THEN NULL ELSE method_id END AS method_id,
                 (to_addr IS NULL) AS to_null, count(*)::int AS txs
          FROM elysium_tx WHERE from_addr = ${a} AND NOT is_spam
          GROUP BY 1, 2 ORDER BY txs DESC LIMIT 6`,
        this.methodNames(),
      ]);

      const txs24h = act[0]?.txs24h ?? 0;
      const total24h = net;
      const share24h = share(txs24h, total24h);
      const contracts = deploys[0]?.n ?? 0;
      const swaps = dex[0]?.swaps ?? 0;
      const b = bridge[0] ?? { deposits: 0, withdrawals: 0, hype_in: 0, hype_out: 0 };
      const botLike = txs24h >= BOT_TXS_24H || (txs24h > 0 && share24h >= BOT_SHARE_24H);

      const tags: Array<{ id: string; label: string; detail: string }> = [];
      if (contracts > 0) tags.push({ id: 'deployer', label: 'Deployer', detail: `${contracts} contracts` });
      if (swaps > 0) tags.push({ id: 'dex-trader', label: 'DEX trader', detail: `${swaps} swaps` });
      if (b.deposits + b.withdrawals > 0) {
        tags.push({ id: 'bridger', label: 'Bridger', detail: `${b.deposits} in / ${b.withdrawals} out` });
      }
      if (botLike) {
        tags.push({ id: 'bot-like', label: 'Bot-like', detail: `${txs24h} txs in 24h (${(share24h * 100).toFixed(2)}% of all)` });
      }

      return {
        address: a,
        firstSeen: iso(seen[0]?.first_seen ?? null),
        activity: { userTxs: act[0]?.txs ?? 0, activeDays: act[0]?.days ?? 0, txs24h, share24h, networkTxs24h: total24h },
        deployer: { contracts, lastDeploy: iso(deploys[0]?.last ?? null) },
        dex: { swaps, pools: dex[0]?.pools ?? 0, swaps24h: dex[0]?.swaps24h ?? 0 },
        bridge: { deposits: b.deposits, withdrawals: b.withdrawals, hypeIn: num(b.hype_in), hypeOut: num(b.hype_out) },
        topMethods: methods.map((m) =>
          m.to_null
            ? { methodId: '', signature: null, name: 'contract creation', txs: m.txs }
            : { ...this.methodRef(m.method_id, names), txs: m.txs }
        ),
        botRule: { txs24h: BOT_TXS_24H, share24h: BOT_SHARE_24H },
        tags,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 11. contract context (who deployed it, what else they deployed, how it is used)
  // ---------------------------------------------------------------------------

  /**
   * On-chain context for a contract from the ingested tables: deployment,
   * the deployer's other contracts (with token metadata when known), calls
   * over 7 days, token record and DEX role. Bytecode analysis happens client side.
   */
  public getContract(address: string): Promise<unknown> {
    const a = address.toLowerCase();
    return this.cachedFresh('contract', a, async () => {
      const since7d = new Date(Date.now() - 7 * DAY_MS);
      const [dep, token, usage, allTime, methods, asPool, asFactory, inPools, names] = await Promise.all([
        prismaHistorical.$queryRaw<Array<{ deployer: string; deploy_tx: string; deployed_at: number; block_number: bigint }>>`
          SELECT deployer, deploy_tx, (extract(epoch FROM deployed_at) * 1000)::float8 AS deployed_at, block_number
          FROM elysium_contract WHERE address = ${a}`,
        prismaHistorical.$queryRaw<Array<{ standard: string; name: string | null; symbol: string | null; decimals: number | null; origin: string | null; transfer_count: bigint }>>`
          SELECT standard, name, symbol, decimals, origin, transfer_count FROM elysium_token WHERE address = ${a}`,
        prismaHistorical.$queryRaw<Array<{ txs: number; callers: number; failed: number }>>`
          SELECT count(*)::int AS txs, count(DISTINCT from_addr)::int AS callers,
                 count(*) FILTER (WHERE NOT success)::int AS failed
          FROM elysium_tx WHERE to_addr = ${a} AND block_time >= ${ts(since7d)}::timestamptz AND NOT is_spam`,
        // First and last call through the (to_addr, block_time) index: an all-time count is too slow on busy contracts.
        prismaHistorical.$queryRaw<Array<{ first: number | null; last: number | null }>>`
          SELECT (SELECT (extract(epoch FROM block_time) * 1000)::float8 FROM elysium_tx WHERE to_addr = ${a} ORDER BY block_time ASC LIMIT 1) AS first,
                 (SELECT (extract(epoch FROM block_time) * 1000)::float8 FROM elysium_tx WHERE to_addr = ${a} ORDER BY block_time DESC LIMIT 1) AS last`,
        prismaHistorical.$queryRaw<Array<{ method_id: string | null; txs: number }>>`
          SELECT method_id, count(*)::int AS txs FROM elysium_tx
          WHERE to_addr = ${a} AND block_time >= ${ts(since7d)}::timestamptz AND NOT is_spam
          GROUP BY 1 ORDER BY txs DESC LIMIT 8`,
        prismaHistorical.$queryRaw<Array<{ factory: string; version: string; token0: string; token1: string; fee: number | null }>>`
          SELECT factory, version, token0, token1, fee FROM elysium_dex_pool WHERE pool = ${a}`,
        prismaHistorical.$queryRaw<Array<{ pools: number; version: string | null }>>`
          SELECT count(*)::int AS pools, max(version) AS version FROM elysium_dex_pool WHERE factory = ${a}`,
        prismaHistorical.$queryRaw<Array<{ pool: string; version: string; other: string }>>`
          SELECT pool, version, CASE WHEN token0 = ${a} THEN token1 ELSE token0 END AS other
          FROM elysium_dex_pool WHERE token0 = ${a} OR token1 = ${a} ORDER BY created_at DESC LIMIT 10`,
        this.methodNames(),
      ]);

      const d = dep[0];
      let deployer: unknown = null;
      if (d) {
        const [count, siblings] = await Promise.all([
          prismaHistorical.$queryRaw<Array<{ n: number; first: number | null }>>`
            SELECT count(*)::int AS n, (extract(epoch FROM min(deployed_at)) * 1000)::float8 AS first
            FROM elysium_contract WHERE deployer = ${d.deployer}`,
          prismaHistorical.$queryRaw<Array<{ address: string; deployed_at: number; name: string | null; symbol: string | null; standard: string | null }>>`
            SELECT c.address, (extract(epoch FROM c.deployed_at) * 1000)::float8 AS deployed_at, t.name, t.symbol, t.standard
            FROM elysium_contract c LEFT JOIN elysium_token t ON t.address = c.address
            WHERE c.deployer = ${d.deployer} AND c.address <> ${a}
            ORDER BY (t.symbol IS NULL), c.deployed_at DESC LIMIT 12`,
        ]);
        deployer = {
          address: d.deployer,
          contracts: count[0]?.n ?? 0,
          firstDeploy: iso(count[0]?.first ?? null),
          others: siblings.map((s) => ({
            address: s.address,
            deployedAt: iso(s.deployed_at),
            name: s.name,
            symbol: s.symbol,
            standard: s.standard,
          })),
        };
      }

      const t = token[0];
      const pool = asPool[0];
      const f = asFactory[0];
      return {
        address: a,
        deployment: d
          ? { deployer: d.deployer, tx: d.deploy_tx, at: iso(d.deployed_at), block: Number(d.block_number) }
          : null,
        deployer,
        token: t
          ? { standard: t.standard, name: t.name, symbol: t.symbol, decimals: t.decimals, origin: t.origin, transfers: Number(t.transfer_count) }
          : null,
        usage: {
          txs7d: usage[0]?.txs ?? 0,
          callers7d: usage[0]?.callers ?? 0,
          failed7d: usage[0]?.failed ?? 0,
          firstCall: iso(allTime[0]?.first ?? null),
          lastCall: iso(allTime[0]?.last ?? null),
          topMethods: methods.map((m) => ({ ...this.methodRef(m.method_id, names), txs: m.txs })),
        },
        dex: {
          pool: pool ? { factory: pool.factory, version: pool.version, token0: pool.token0, token1: pool.token1, fee: pool.fee } : null,
          factory: f && f.pools > 0 ? { pools: f.pools, version: f.version } : null,
          pools: inPools.map((p) => ({ pool: p.pool, version: p.version, pairedWith: p.other })),
        },
      };
    });
  }
}
