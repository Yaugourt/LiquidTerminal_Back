import { Prisma } from '../../../prisma-historical/generated/client';
import { prismaHistoricalAggregate, prismaHistoricalPages, prismaHistoricalRead } from '../../core/prisma.historical.service';
import { cacheService } from '../../core/cache.service';
import { ViewResult, viewScheduler, type ViewCadence, type ViewDef } from '../../core/viewScheduler';
import { ELYSIUM_STATE_MARKERS, ElysiumIngestRepository } from '../../repositories/prisma/prisma.elysium.repository';
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
import { distinctCallers, planRollupWindow, rawRanges, readRollupCoverage, rollupDays } from './elysium-rollup.reader';
import { errorCategory } from './elysium-analytics.util';
import { ELYSIUM_GENESIS } from './elysium-ingest.util';
import { closedRollupDays, firstKeptDay, rollupKeepDays } from './elysium-rollup.util';

const CACHE_TTL_S = 60;
const CACHE_PREFIX = 'elysium:analytics';
/** The scheduled views run on the aggregates' pool; only the address and contract profiles stay on the read pool. */
const agg = prismaHistoricalAggregate;

/**
 * How often each kind of view is computed by the view scheduler: while someone
 * is watching it, and when nobody is. Sized on what a computation takes on
 * prod (measured 2026-11-11, one view at a time): 2 to 6 s for the windows of
 * a day and the daily series, 25 to 38 s over 7 days, 97 s for fees over 30
 * days. A visit never starts one.
 */
const CADENCE = {
  /** Windows of 24h and the 14-day daily series the pages open on. */
  day: { activeS: 60, idleS: 600 },
  /** Windows of 7 days. */
  week: { activeS: 300, idleS: 1800, heavy: true },
  /** Fees over 30 days. */
  month: { activeS: 1800, idleS: 3600, heavy: true },
  /**
   * The ingestion's own state: looked at when something is wrong, so a request that finds no
   * value (the first seconds of a process) computes it on the spot, it takes milliseconds.
   */
  status: { activeS: 15, idleS: 60, cheap: true },
} as const satisfies Record<string, ViewCadence>;

/**
 * A daily series over `days`. The pages ask for 14, kept warm; the other
 * lengths the route accepts are computed only while someone asks for them,
 * the longer ones as heavy views.
 */
function dailyCadence(days: number): ViewCadence {
  if (days === 14) return CADENCE.day;
  return days < 14 ? { activeS: 60, idleS: 0 } : { activeS: 300, idleS: 0, heavy: true };
}
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
 * current day is flagged `partial: true`. The views are computed by the view
 * scheduler at their own period (see CADENCE) and requests only read them; the
 * address and contract profiles, one per address, are computed on request and
 * cached 60 s.
 *
 * The windows wider than a day read the whole UTC days that are built from the
 * day rollups and the rest of the window (its partial first day, today, a day
 * not built yet) from elysium_tx: see elysium-rollup.util. The split changes
 * how much is read, never a figure.
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
   * A view the scheduler computes at `cadence` and that requests only read
   * (see ViewScheduler): the heavier aggregates take seconds to minutes over
   * the tx table, and no visit should start one or wait for one.
   */
  private view<T>(name: string, params: string, cadence: ViewCadence, compute: () => Promise<T>): ViewDef<T> {
    return { key: `${CACHE_PREFIX}:${name}:${params}`, cadence, compute };
  }

  /** Plain 60s cache for per-address reads, where a stale answer would mislead. */
  private cachedFresh<T>(name: string, params: string, fn: () => Promise<T>): Promise<T> {
    return cacheService.getOrSet<T>(`${CACHE_PREFIX}:${name}:${params}`, fn, CACHE_TTL_S);
  }

  /**
   * Hands the scheduler the views the Elysium pages open on, so that they are
   * kept computed whether or not anyone is looking: every window of the
   * contracts, methods and fees pages, the 14-day series, and the status.
   */
  public registerDefaults(): void {
    for (const view of [
      this.statusView(),
      this.deploymentsView(14),
      this.contractsView('24h'),
      this.contractsView('7d'),
      this.usersView(14),
      this.bridgeView(14),
      this.economicsView(14),
      this.methodsView('24h'),
      this.methodsView('7d'),
      this.dexView(14),
      this.tokensView(14),
      this.feesView('24h'),
      this.feesView('7d'),
      this.feesView('30d'),
      this.networkTxs24hView(),
    ]) {
      viewScheduler.register(view);
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

  /**
   * The ingestion streams, and where the day rollups stand: how many days are
   * built, the span they cover, how many wait for a (re)build, the builder's
   * last error, and what the rollup tables and the transaction table weigh on
   * disk (indexes included). The only view of the rollups from outside the
   * database.
   */
  public async getStatus(): Promise<
    ViewResult<{
      streams: Array<Record<string, unknown>>;
      rollups: Record<string, unknown>;
      rejects: Array<Record<string, unknown>>;
      views: Array<Record<string, unknown>>;
    }>
  > {
    const status = await viewScheduler.read(this.statusView());
    // Where the scheduled views stand is read from this process as the request comes, never stored.
    return new ViewResult({ ...status.data, views: viewScheduler.describe() }, status.computedAt, status.refreshEveryS);
  }

  /**
   * Computed by the scheduler like the other views, on the pages' pool, and
   * served from memory: the route answers whatever the database is doing. It
   * used to read the analytics pool on request and did not answer for 20 s
   * while that pool was full of aggregates.
   */
  private statusView(): ViewDef<{
    streams: Array<Record<string, unknown>>;
    rollups: Record<string, unknown>;
    rejects: Array<Record<string, unknown>>;
  }> {
    return this.view('status', 'v3', CADENCE.status, async () => {
      const [all, days, sizes, rejects] = await Promise.all([
        ElysiumIngestRepository.getInstance().listStates(),
        prismaHistoricalPages.$queryRaw<Array<{ day: string; built_ms: number | null }>>`
          SELECT day::text AS day, (extract(epoch FROM built_at) * 1000)::float8 AS built_ms
          FROM elysium_day_rollup
          WHERE built_at IS NOT NULL AND NOT dirty AND day >= ${firstKeptDay(new Date(), rollupKeepDays())}::date
          ORDER BY day`.catch(() => []),
        prismaHistoricalPages.$queryRaw<Array<{ rollups: number; tx: number }>>`
          SELECT (pg_total_relation_size('elysium_call_day') + pg_total_relation_size('elysium_caller_day')
                  + pg_total_relation_size('elysium_caller_set') + pg_total_relation_size('elysium_method_sender_day')
                  + pg_total_relation_size('elysium_day_rollup'))::float8 AS rollups,
                 pg_total_relation_size('elysium_tx')::float8 AS tx`.catch(() => []),
        // What the ingestion read and did not store over the last 7 UTC days, per stream and reason.
        prismaHistoricalPages.$queryRaw<
          Array<{ stream: string; reason: string; today: number; yesterday: number; week: number; last_ms: number }>
        >`
          SELECT stream, reason,
                 COALESCE(sum(count) FILTER (WHERE day = (now() AT TIME ZONE 'UTC')::date), 0)::float8 AS today,
                 COALESCE(sum(count) FILTER (WHERE day = (now() AT TIME ZONE 'UTC')::date - 1), 0)::float8 AS yesterday,
                 sum(count)::float8 AS week,
                 (extract(epoch FROM max(last_at)) * 1000)::float8 AS last_ms
          FROM elysium_ingest_reject
          WHERE day >= (now() AT TIME ZONE 'UTC')::date - 6
          GROUP BY stream, reason
          ORDER BY stream, reason`.catch(() => []),
      ]);
      // Markers (a one-time rebuild, a position in a listing) are not streams: they have no lag to show.
      const rows = all.filter((r) => !ELYSIUM_STATE_MARKERS.has(r.stream));
      const builder = all.find((r) => r.stream === 'rollup');
      const now = Date.now();
      const built = new Set(days.map((d) => d.day.slice(0, 10)));
      // Every closed day the builder is due to have built, whether it has a row yet or not.
      const txCursor = all.find((r) => r.stream === 'tx')?.cursor ?? null;
      const due = closedRollupDays(txCursor, new Date(now), ELYSIUM_GENESIS);
      const lastBuilt = days.reduce<number | null>((m, d) => (d.built_ms !== null && (m === null || d.built_ms > m) ? d.built_ms : m), null);
      return {
        streams: rows.map((r) => ({
          stream: r.stream,
          cursor: r.cursor ? r.cursor.toISOString() : null,
          rows: Number(r.rows),
          backfillDone: r.backfillDone,
          lastError: errorCategory(r.lastError),
          lagSeconds: r.cursor ? Math.max(0, Math.round((now - r.cursor.getTime()) / 1000)) : null,
        })),
        rollups: {
          builtDays: built.size,
          waitingDays: due.filter((day) => !built.has(day)).length,
          firstDay: days[0]?.day.slice(0, 10) ?? null,
          lastDay: days[days.length - 1]?.day.slice(0, 10) ?? null,
          lastBuiltAt: iso(lastBuilt),
          keepDays: rollupKeepDays(),
          sizeBytes: sizes[0] ? Number(sizes[0].rollups) : null,
          txTableBytes: sizes[0] ? Number(sizes[0].tx) : null,
          lastError: errorCategory(builder?.lastError ?? null),
        },
        // Counts only: the stored example of each stays in the database.
        rejects: rejects.map((r) => ({
          stream: r.stream,
          reason: r.reason,
          today: Number(r.today),
          yesterday: Number(r.yesterday),
          last7d: Number(r.week),
          lastAt: iso(Number(r.last_ms)),
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 2. deployments
  // ---------------------------------------------------------------------------

  public getDeployments(days: number): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.deploymentsView(days));
  }

  private deploymentsView(days: number): ViewDef<unknown> {
    return this.view('deployments', `d${days}`, dailyCadence(days), async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);
      const since7d = new Date(now.getTime() - 7 * DAY_MS);
      const since24h = new Date(now.getTime() - DAY_MS);

      const [daily, top, trending] = await Promise.all([
        agg.$queryRaw<Array<{ day: string; deployments: number; deployers: number }>>`
          SELECT (deployed_at AT TIME ZONE 'UTC')::date::text AS day,
                 count(*)::int AS deployments, count(DISTINCT deployer)::int AS deployers
          FROM elysium_contract WHERE deployed_at >= ${ts(start)}::timestamptz
          GROUP BY 1`,
        agg.$queryRaw<
          Array<{ address: string; deployments: number; first_deploy: number; last_deploy: number }>
        >`
          SELECT deployer AS address, count(*)::int AS deployments,
                 (extract(epoch FROM min(deployed_at)) * 1000)::float8 AS first_deploy, (extract(epoch FROM max(deployed_at)) * 1000)::float8 AS last_deploy
          FROM elysium_contract WHERE deployed_at >= ${ts(since7d)}::timestamptz
          GROUP BY deployer ORDER BY deployments DESC, address LIMIT 15`,
        agg.$queryRaw<
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
  public getContracts(window: ContractsWindow): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.contractsView(window));
  }

  private contractsView(window: ContractsWindow): ViewDef<unknown> {
    return this.view('contracts', window, window === '7d' ? CADENCE.week : CADENCE.day, async () => {
      const spanMs = window === '7d' ? 7 * DAY_MS : DAY_MS;
      const now = new Date();
      const curStart = new Date(now.getTime() - spanMs);
      const prevStart = new Date(now.getTime() - 2 * spanMs);
      const coverage = await readRollupCoverage(now);
      const cur = planRollupWindow(curStart, now, coverage);
      const prev = planRollupWindow(prevStart, curStart, coverage);
      const curRaw = rawRanges(Prisma.sql`t.block_time`, cur);

      const top = await agg.$queryRaw<Array<{ address: string; txs: number; gas_used: string }>>`
        WITH agg AS (
          -- Rollup rows and raw rows go to one aggregation: grouping each side first, then
          -- again together, sorted the rollup rows twice.
          SELECT address, sum(txs)::int AS txs, sum(gas)::text AS gas_used FROM (
            SELECT d.to_addr AS address, d.txs, d.gas_used AS gas
            FROM elysium_call_day d WHERE d.day = ANY(${rollupDays(cur)})
            UNION ALL
            SELECT t.to_addr, 1, t.gas_used
            FROM elysium_tx t
            WHERE ${curRaw} AND NOT t.is_spam AND t.to_addr IS NOT NULL
          ) u GROUP BY address
        )
        SELECT a.address, a.txs, a.gas_used FROM agg a
        WHERE a.address LIKE ${PRECOMPILE_LIKE}
           OR EXISTS (SELECT 1 FROM elysium_contract c WHERE c.address = a.address)
           OR EXISTS (SELECT 1 FROM elysium_token k WHERE k.address = a.address)
        ORDER BY a.txs DESC, a.address
        LIMIT 25`;

      const addrs = top.map((r) => r.address);
      const [meta, prevTxs, callers, callersPrev, methodRows, names] = await Promise.all([
        addrs.length
          ? agg.$queryRaw<
              Array<{
                address: string;
                deployer: string | null;
                deployed_at: number | null;
                name: string | null;
                symbol: string | null;
                is_token: boolean;
              }>
            >`
              SELECT a.address, c.deployer, (extract(epoch FROM c.deployed_at) * 1000)::float8 AS deployed_at,
                     tk.name, tk.symbol, (tk.address IS NOT NULL) AS is_token
              FROM unnest(${addrs}::text[]) AS a(address)
              LEFT JOIN elysium_contract c ON c.address = a.address
              LEFT JOIN elysium_token tk ON tk.address = a.address`
          : Promise.resolve([]),
        addrs.length
          ? agg.$queryRaw<Array<{ address: string; txs: number }>>`
              SELECT address, sum(txs)::int AS txs FROM (
                SELECT d.to_addr AS address, sum(d.txs)::bigint AS txs
                FROM elysium_call_day d
                WHERE d.day = ANY(${rollupDays(prev)}) AND d.to_addr = ANY(${addrs}::text[])
                GROUP BY d.to_addr
                UNION ALL
                SELECT t.to_addr, count(*)::bigint
                FROM elysium_tx t
                WHERE t.to_addr = ANY(${addrs}::text[]) AND ${rawRanges(Prisma.sql`t.block_time`, prev)} AND NOT t.is_spam
                GROUP BY t.to_addr
              ) u GROUP BY address`
          : Promise.resolve([]),
        distinctCallers(addrs, curStart, now, coverage),
        distinctCallers(addrs, prevStart, curStart, coverage),
        addrs.length
          ? agg.$queryRaw<Array<{ address: string; method_id: string | null; txs: number }>>`
              SELECT address, method_id, txs FROM (
                SELECT address, method_id, sum(txs)::int AS txs,
                       row_number() OVER (PARTITION BY address ORDER BY sum(txs) DESC, method_id) AS rk
                FROM (
                  SELECT d.to_addr AS address, NULLIF(d.method_id, '') AS method_id, sum(d.txs)::bigint AS txs
                  FROM elysium_call_day d
                  WHERE d.day = ANY(${rollupDays(cur)}) AND d.to_addr = ANY(${addrs}::text[])
                  GROUP BY 1, 2
                  UNION ALL
                  SELECT t.to_addr, t.method_id, count(*)::bigint
                  FROM elysium_tx t
                  WHERE t.to_addr = ANY(${addrs}::text[]) AND ${curRaw} AND NOT t.is_spam
                  GROUP BY 1, 2
                ) u GROUP BY address, method_id
              ) x WHERE rk <= 3 ORDER BY address, txs DESC, method_id`
          : Promise.resolve([]),
        this.methodNames(),
      ]);
      const metaBy = new Map(meta.map((m) => [m.address, m]));
      const prevBy = new Map(prevTxs.map((r) => [r.address, r.txs]));
      const rows = top.map((r) => {
        const m = metaBy.get(r.address);
        return {
          address: r.address,
          txs: r.txs,
          callers: callers.get(r.address) ?? 0,
          gas_used: r.gas_used,
          txs_prev: prevBy.get(r.address) ?? null,
          callers_prev: callersPrev.get(r.address) ?? null,
          deployer: m?.deployer ?? null,
          deployed_at: m?.deployed_at ?? null,
          name: m?.name ?? null,
          symbol: m?.symbol ?? null,
          is_token: m?.is_token ?? false,
        };
      });
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
  public getUsers(days: number): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.usersView(days));
  }

  private usersView(days: number): ViewDef<unknown> {
    return this.view('users', `d${days}`, dailyCadence(days), async () => {
      const now = new Date();
      const { keys } = this.rangeStart(now, days);
      const startDay = keys[0];
      const since24h = new Date(now.getTime() - DAY_MS);

      const [active, fresh, cohorts, senders] = await Promise.all([
        agg.$queryRaw<Array<{ day: string; n: number }>>`
          SELECT day::text AS day, count(*)::int AS n FROM elysium_address_day
          WHERE day >= ${startDay}::date GROUP BY day`,
        agg.$queryRaw<Array<{ day: string; n: number }>>`
          SELECT first_day::text AS day, count(*)::int AS n FROM elysium_address
          WHERE first_day >= ${startDay}::date GROUP BY first_day`,
        agg.$queryRaw<Array<{ day: string; size: number; d1: number; d7: number }>>`
          SELECT a.first_day::text AS day, count(*)::int AS size,
                 count(d1.address)::int AS d1, count(d7.address)::int AS d7
          FROM elysium_address a
          LEFT JOIN elysium_address_day d1 ON d1.address = a.address AND d1.day = a.first_day + 1
          LEFT JOIN elysium_address_day d7 ON d7.address = a.address AND d7.day = a.first_day + 7
          WHERE a.first_day >= ${startDay}::date
          GROUP BY a.first_day`,
        agg.$queryRaw<
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
  public getBridge(days: number): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.bridgeView(days));
  }

  private bridgeView(days: number): ViewDef<unknown> {
    return this.view('bridge', `d${days}`, dailyCadence(days), async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);

      const [daily, tokens, finality, bridgers] = await Promise.all([
        agg.$queryRaw<
          Array<{ day: string; deposits: number; withdrawals: number; hype_in: number; hype_out: number }>
        >`
          SELECT (initiated_at AT TIME ZONE 'UTC')::date::text AS day,
                 count(*) FILTER (WHERE direction = 'deposit')::int AS deposits,
                 count(*) FILTER (WHERE direction = 'withdrawal')::int AS withdrawals,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'deposit' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_in,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'withdrawal' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_out
          FROM elysium_bridge_transfer WHERE initiated_at >= ${ts(start)}::timestamptz
          GROUP BY 1`,
        agg.$queryRaw<
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
        agg.$queryRaw<
          Array<{ direction: string; completed: number; median_s: number | null; p90_s: number | null }>
        >`
          SELECT direction, count(*)::int AS completed,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_s) AS median_s,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_s) AS p90_s
          FROM elysium_bridge_transfer
          WHERE initiated_at >= ${ts(start)}::timestamptz AND completed_at IS NOT NULL AND duration_s IS NOT NULL
          GROUP BY direction ORDER BY direction`,
        agg.$queryRaw<
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
   * posting part (fee_wei is the full receipt fee). Computed every minute
   * (24h), 5 min (7d) and 30 min (30d) while watched. The built days of the
   * window come from the day rollups.
   */
  public getFees(window: FeesWindow): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.feesView(window));
  }

  private feesView(window: FeesWindow): ViewDef<unknown> {
    return this.view(
      'fees',
      window,
      window === '30d' ? CADENCE.month : window === '7d' ? CADENCE.week : CADENCE.day,
      async () => {
        const spanMs = (window === '30d' ? 30 : window === '7d' ? 7 : 1) * DAY_MS;
        const now = new Date();
        const start = new Date(now.getTime() - spanMs);
        const prevStart = new Date(now.getTime() - 2 * spanMs);
        const coverage = await readRollupCoverage(now);
        const cur = planRollupWindow(start, now, coverage);
        const prevPlan = planRollupWindow(prevStart, start, coverage);

        const rows = await agg.$queryRaw<
          Array<{ kind: string; key: string | null; fees: number; txs: number; gas: string | null; n: number }>
        >`
          WITH f AS (
            SELECT address, sum(fee) AS fee, sum(txs)::int AS txs, sum(gas) AS gas FROM (
              SELECT d.to_addr AS address, d.fee_wei AS fee, d.txs, d.gas_used AS gas
              FROM elysium_call_day d WHERE d.day = ANY(${rollupDays(cur)})
              UNION ALL
              SELECT t.to_addr, t.fee_wei, 1, t.gas_used
              FROM elysium_tx t
              WHERE ${rawRanges(Prisma.sql`t.block_time`, cur)} AND NOT t.is_spam AND t.to_addr IS NOT NULL
            ) u GROUP BY address
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
              agg.$queryRaw<
                Array<{ address: string; deployer: string | null; name: string | null; symbol: string | null; is_token: boolean }>
              >`
                SELECT a.address, c.deployer, tk.name, tk.symbol, (tk.address IS NOT NULL) AS is_token
                FROM unnest(${addrs}::text[]) AS a(address)
                LEFT JOIN elysium_contract c ON c.address = a.address
                LEFT JOIN elysium_token tk ON tk.address = a.address`,
              agg.$queryRaw<Array<{ address: string; fees: number }>>`
                SELECT address, (sum(fee) / 1e18)::float8 AS fees FROM (
                  SELECT d.to_addr AS address, sum(d.fee_wei) AS fee
                  FROM elysium_call_day d
                  WHERE d.day = ANY(${rollupDays(prevPlan)}) AND d.to_addr = ANY(${addrs}::text[])
                  GROUP BY d.to_addr
                  UNION ALL
                  SELECT t.to_addr, sum(t.fee_wei)
                  FROM elysium_tx t
                  WHERE t.to_addr = ANY(${addrs}::text[]) AND NOT t.is_spam
                    AND ${rawRanges(Prisma.sql`t.block_time`, prevPlan)}
                  GROUP BY t.to_addr
                ) u GROUP BY address`,
              distinctCallers(addrs, start, now, coverage),
            ])
          : [[], [], new Map<string, number>()];
        const metaBy = new Map(meta.map((m) => [m.address, m]));
        const prevBy = new Map(prev.map((p) => [p.address, num(p.fees)]));
        const callersBy = callers;

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
      }
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
  public getEconomics(days: number): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.economicsView(days));
  }

  private economicsView(days: number): ViewDef<unknown> {
    return this.view('economics', `d${days}`, dailyCadence(days), async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);
      // Up to the end of today: a built day is one row, the others are counted from the raw table.
      const end = new Date(new Date(`${keys[keys.length - 1]}T00:00:00Z`).getTime() + DAY_MS);
      const plan = planRollupWindow(start, end, await readRollupCoverage(now));

      const rows = await agg.$queryRaw<
        Array<{ day: string; txs: number; spam: number; failed: number; bridge: number; fees: number }>
      >`
        SELECT r.day::text AS day, r.txs, r.spam_txs AS spam, r.failed_txs AS failed, r.bridge_txs AS bridge,
               (r.fee_wei / 1e18)::float8 AS fees
        FROM elysium_day_rollup r WHERE r.day = ANY(${rollupDays(plan)})
        UNION ALL
        SELECT (t.block_time AT TIME ZONE 'UTC')::date::text AS day,
               count(*) FILTER (WHERE NOT t.is_spam)::int AS txs,
               count(*) FILTER (WHERE t.is_spam)::int AS spam,
               count(*) FILTER (WHERE NOT t.is_spam AND NOT t.success)::int AS failed,
               count(*) FILTER (WHERE NOT t.is_spam AND t.tx_type IN ('0x64', '0x68', '0x69'))::int AS bridge,
               (COALESCE(sum(t.fee_wei), 0) / 1e18)::float8 AS fees
        FROM elysium_tx t WHERE ${rawRanges(Prisma.sql`t.block_time`, plan)}
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
  private methodNames(db: typeof agg = agg): Promise<Record<string, string>> {
    return cacheService.getOrSet<Record<string, string>>(
      `${CACHE_PREFIX}:method-names:v1`,
      async () => {
        // On the caller's own pool: a profile, computed on request, must not queue behind the
        // scheduled views on the aggregates' pool for a lookup it waits for.
        const rows = await db.$queryRaw<Array<{ method_id: string; signature: string }>>`
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
  public getMethods(window: ContractsWindow): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.methodsView(window));
  }

  private methodsView(window: ContractsWindow): ViewDef<unknown> {
    return this.view('methods', window, window === '7d' ? CADENCE.week : CADENCE.day, async () => {
      const spanMs = window === '7d' ? 7 * DAY_MS : DAY_MS;
      const now = new Date();
      const start = new Date(now.getTime() - spanMs);
      // One split for the whole view: a day is taken from the rollups only if its sender
      // lists are there too, so the counts and the distinct senders cover the same rows.
      const plan = planRollupWindow(start, now, await readRollupCoverage(now), 'senders');
      const raw = rawRanges(Prisma.sql`t.block_time`, plan);
      const [rows, totals, names, resolved] = await Promise.all([
        // Top selectors first, then distinct senders / contracts via two-level
        // hash aggregates (count(DISTINCT) per group sorts and takes ~40s here).
        // The raw part of the window is read once (`edge`) and shared by the three.
        agg.$queryRaw<Array<{ method_id: string; txs: number; senders: number; contracts: number }>>`
          WITH edge AS MATERIALIZED (
            SELECT t.method_id, t.from_addr, t.to_addr FROM elysium_tx t
            WHERE ${raw} AND NOT t.is_spam AND t.to_addr IS NOT NULL AND t.method_id IS NOT NULL
          ),
          top AS (
            SELECT method_id, sum(txs)::int AS txs FROM (
              SELECT d.method_id, d.txs
              FROM elysium_call_day d WHERE d.day = ANY(${rollupDays(plan)}) AND d.method_id <> ''
              UNION ALL
              SELECT e.method_id, 1 FROM edge e
            ) u GROUP BY method_id ORDER BY 2 DESC, method_id LIMIT 25
          ),
          s AS (
            SELECT method_id, count(*)::int AS n FROM (
              SELECT p.method_id, p.from_addr
              FROM elysium_method_sender_day p JOIN top USING (method_id)
              WHERE p.day = ANY(${rollupDays(plan)})
              UNION
              SELECT e.method_id, e.from_addr FROM edge e JOIN top USING (method_id)
            ) x GROUP BY 1
          ),
          c AS (
            SELECT method_id, count(*)::int AS n FROM (
              SELECT d.method_id, d.to_addr
              FROM elysium_call_day d JOIN top USING (method_id)
              WHERE d.day = ANY(${rollupDays(plan)})
              UNION
              SELECT e.method_id, e.to_addr FROM edge e JOIN top USING (method_id)
            ) x GROUP BY 1
          )
          SELECT top.method_id, top.txs, COALESCE(s.n, 0) AS senders, COALESCE(c.n, 0) AS contracts
          FROM top LEFT JOIN s USING (method_id) LEFT JOIN c USING (method_id)
          ORDER BY top.txs DESC, top.method_id`,
        agg.$queryRaw<Array<{ calls: number; transfers: number; creations: number }>>`
          SELECT sum(calls)::int AS calls, sum(transfers)::int AS transfers, sum(creations)::int AS creations FROM (
            SELECT r.calls::bigint AS calls, r.transfers::bigint AS transfers, r.creations::bigint AS creations
            FROM elysium_day_rollup r WHERE r.day = ANY(${rollupDays(plan)})
            UNION ALL
            SELECT count(*) FILTER (WHERE t.to_addr IS NOT NULL AND t.method_id IS NOT NULL)::bigint,
                   count(*) FILTER (WHERE t.to_addr IS NOT NULL AND t.method_id IS NULL)::bigint,
                   count(*) FILTER (WHERE t.to_addr IS NULL)::bigint
            FROM elysium_tx t
            WHERE ${raw} AND NOT t.is_spam
          ) u`,
        this.methodNames(),
        agg.$queryRaw<Array<{ looked_up: number; found: number }>>`
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
  public getDex(days: number): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.dexView(days));
  }

  private dexView(days: number): ViewDef<unknown> {
    return this.view('dex', `d${days}`, dailyCadence(days), async () => {
      const now = new Date();
      const { keys, start } = this.rangeStart(now, days);
      const since24h = new Date(now.getTime() - DAY_MS);

      const [pools, swaps, factories, top, fresh, totals] = await Promise.all([
        agg.$queryRaw<Array<{ day: string; n: number }>>`
          SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n
          FROM elysium_dex_pool WHERE created_at >= ${ts(start)}::timestamptz GROUP BY 1`,
        agg.$queryRaw<Array<{ day: string; swaps: number; active: number }>>`
          SELECT (block_time AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS swaps,
                 count(DISTINCT pool)::int AS active
          FROM elysium_dex_swap WHERE block_time >= ${ts(start)}::timestamptz GROUP BY 1`,
        agg.$queryRaw<
          Array<{ address: string; versions: string; pools: number; swaps24h: number; last_pool: number }>
        >`
          SELECT p.factory AS address, string_agg(DISTINCT p.version, ',') AS versions,
                 count(DISTINCT p.pool)::int AS pools,
                 (SELECT count(*) FROM elysium_dex_swap s JOIN elysium_dex_pool q ON q.pool = s.pool
                   WHERE q.factory = p.factory AND s.block_time >= ${ts(since24h)}::timestamptz)::int AS swaps24h,
                 (extract(epoch FROM max(p.created_at)) * 1000)::float8 AS last_pool
          FROM elysium_dex_pool p GROUP BY p.factory ORDER BY pools DESC, address LIMIT 15`,
        agg.$queryRaw<
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
        agg.$queryRaw<
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
        agg.$queryRaw<
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
  public getTokens(days: number): Promise<ViewResult<unknown>> {
    return viewScheduler.read(this.tokensView(days));
  }

  private tokensView(days: number): ViewDef<unknown> {
    return this.view('tokens', `d${days}`, dailyCadence(days), async () => {
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
        agg.$queryRaw<Array<{ day: string; launched: number; named: number }>>`
          SELECT (first_seen AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS launched,
                 count(*) FILTER (WHERE symbol IS NOT NULL)::int AS named
          FROM elysium_token WHERE standard = 'erc20' AND first_seen >= ${ts(start)}::timestamptz GROUP BY 1`,
        agg.$queryRaw<TokenOut[]>`
          SELECT k.address, k.name, k.symbol, k.decimals, k.origin,
                 (extract(epoch FROM k.first_seen) * 1000)::float8 AS first_seen, k.transfer_count::text AS transfers,
                 s.holders, (extract(epoch FROM s.fetched_at) * 1000)::float8 AS holders_at
          FROM elysium_token k LEFT JOIN elysium_token_stat s ON s.address = k.address
          WHERE k.standard = 'erc20' AND k.symbol IS NOT NULL AND k.first_seen >= ${ts(since24h)}::timestamptz
          ORDER BY k.transfer_count DESC, k.address LIMIT 25`,
        agg.$queryRaw<TokenOut[]>`
          SELECT k.address, k.name, k.symbol, k.decimals, k.origin,
                 (extract(epoch FROM k.first_seen) * 1000)::float8 AS first_seen, k.transfer_count::text AS transfers,
                 s.holders, (extract(epoch FROM s.fetched_at) * 1000)::float8 AS holders_at
          FROM elysium_token k LEFT JOIN elysium_token_stat s ON s.address = k.address
          WHERE k.standard = 'erc20' AND k.symbol IS NOT NULL
          ORDER BY k.transfer_count DESC, k.address LIMIT 25`,
        agg.$queryRaw<Array<{ tokens: number; named: number; launched24h: number; named24h: number }>>`
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
  private async networkTxs24h(): Promise<number> {
    return (await viewScheduler.read(this.networkTxs24hView())).data;
  }

  private networkTxs24hView(): ViewDef<number> {
    return this.view('network-txs-24h', 'v1', CADENCE.day, async () => {
      const since24h = new Date(Date.now() - DAY_MS);
      const rows = await agg.$queryRaw<Array<{ total: number }>>`
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
        prismaHistoricalRead.$queryRaw<Array<{ first_seen: number }>>`
          SELECT (extract(epoch FROM first_seen) * 1000)::float8 AS first_seen FROM elysium_address WHERE address = ${a}`,
        prismaHistoricalRead.$queryRaw<Array<{ txs: number; days: number; txs24h: number }>>`
          SELECT COALESCE(sum(tx_count), 0)::int AS txs, count(*)::int AS days,
                 (SELECT count(*) FROM elysium_tx WHERE from_addr = ${a} AND block_time >= ${ts(since24h)}::timestamptz
                   AND NOT is_spam AND COALESCE(tx_type, '') NOT IN ('0x64', '0x68', '0x69'))::int AS txs24h
          FROM elysium_address_day WHERE address = ${a}`,
        this.networkTxs24h(),
        prismaHistoricalRead.$queryRaw<Array<{ n: number; last: number | null }>>`
          SELECT count(*)::int AS n, (extract(epoch FROM max(deployed_at)) * 1000)::float8 AS last
          FROM elysium_contract WHERE deployer = ${a}`,
        prismaHistoricalRead.$queryRaw<Array<{ swaps: number; pools: number; swaps24h: number }>>`
          SELECT count(*)::int AS swaps, count(DISTINCT s.pool)::int AS pools,
                 count(*) FILTER (WHERE s.block_time >= ${ts(since24h)}::timestamptz)::int AS swaps24h
          FROM elysium_dex_swap s JOIN elysium_tx t ON t.tx_hash = s.tx_hash WHERE t.from_addr = ${a}`,
        prismaHistoricalRead.$queryRaw<
          Array<{ deposits: number; withdrawals: number; hype_in: number; hype_out: number }>
        >`
          SELECT count(*) FILTER (WHERE direction = 'deposit')::int AS deposits,
                 count(*) FILTER (WHERE direction = 'withdrawal')::int AS withdrawals,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'deposit' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_in,
                 COALESCE(sum(amount) FILTER (WHERE direction = 'withdrawal' AND symbol = 'HYPE' AND route = 'native'), 0)::float8 AS hype_out
          FROM elysium_bridge_transfer WHERE from_addr = ${a} OR to_addr = ${a}`,
        prismaHistoricalRead.$queryRaw<Array<{ method_id: string | null; to_null: boolean; txs: number }>>`
          SELECT CASE WHEN to_addr IS NULL THEN NULL ELSE method_id END AS method_id,
                 (to_addr IS NULL) AS to_null, count(*)::int AS txs
          FROM elysium_tx WHERE from_addr = ${a} AND NOT is_spam
          GROUP BY 1, 2 ORDER BY txs DESC LIMIT 6`,
        this.methodNames(prismaHistoricalRead),
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
      const now = new Date();
      const since7d = new Date(now.getTime() - 7 * DAY_MS);
      // One contract's own rows: bounded whatever the plan, so an unreadable list of built days reads them raw.
      const coverage = await readRollupCoverage(now, { db: prismaHistoricalRead, onFailure: 'raw' });
      const week = planRollupWindow(since7d, now, coverage);
      const weekRaw = rawRanges(Prisma.sql`t.block_time`, week);
      const [dep, token, usage, callers7d, allTime, methods, asPool, asFactory, inPools, names, launch] = await Promise.all([
        prismaHistoricalRead.$queryRaw<Array<{ deployer: string; deploy_tx: string; deployed_at: number; block_number: bigint }>>`
          SELECT deployer, deploy_tx, (extract(epoch FROM deployed_at) * 1000)::float8 AS deployed_at, block_number
          FROM elysium_contract WHERE address = ${a}`,
        prismaHistoricalRead.$queryRaw<Array<{ standard: string; name: string | null; symbol: string | null; decimals: number | null; origin: string | null; transfer_count: bigint }>>`
          SELECT standard, name, symbol, decimals, origin, transfer_count FROM elysium_token WHERE address = ${a}`,
        prismaHistoricalRead.$queryRaw<Array<{ txs: number; failed: number }>>`
          SELECT COALESCE(sum(txs), 0)::int AS txs, COALESCE(sum(failed), 0)::int AS failed FROM (
            SELECT sum(d.txs)::bigint AS txs, sum(d.failed)::bigint AS failed
            FROM elysium_call_day d WHERE d.day = ANY(${rollupDays(week)}) AND d.to_addr = ${a}
            UNION ALL
            SELECT count(*)::bigint, count(*) FILTER (WHERE NOT t.success)::bigint
            FROM elysium_tx t WHERE t.to_addr = ${a} AND ${weekRaw} AND NOT t.is_spam
          ) u`,
        distinctCallers([a], since7d, now, coverage, prismaHistoricalRead),
        // First and last call through the (to_addr, block_time) index: an all-time count is too slow on busy contracts.
        prismaHistoricalRead.$queryRaw<Array<{ first: number | null; last: number | null }>>`
          SELECT (SELECT (extract(epoch FROM block_time) * 1000)::float8 FROM elysium_tx WHERE to_addr = ${a} ORDER BY block_time ASC LIMIT 1) AS first,
                 (SELECT (extract(epoch FROM block_time) * 1000)::float8 FROM elysium_tx WHERE to_addr = ${a} ORDER BY block_time DESC LIMIT 1) AS last`,
        prismaHistoricalRead.$queryRaw<Array<{ method_id: string | null; txs: number }>>`
          SELECT method_id, sum(txs)::int AS txs FROM (
            SELECT NULLIF(d.method_id, '') AS method_id, sum(d.txs)::bigint AS txs
            FROM elysium_call_day d WHERE d.day = ANY(${rollupDays(week)}) AND d.to_addr = ${a}
            GROUP BY 1
            UNION ALL
            SELECT t.method_id, count(*)::bigint
            FROM elysium_tx t WHERE t.to_addr = ${a} AND ${weekRaw} AND NOT t.is_spam
            GROUP BY 1
          ) u GROUP BY method_id ORDER BY 2 DESC, method_id LIMIT 8`,
        prismaHistoricalRead.$queryRaw<Array<{ factory: string; version: string; token0: string; token1: string; fee: number | null }>>`
          SELECT factory, version, token0, token1, fee FROM elysium_dex_pool WHERE pool = ${a}`,
        prismaHistoricalRead.$queryRaw<Array<{ pools: number; version: string | null }>>`
          SELECT count(*)::int AS pools, max(version) AS version FROM elysium_dex_pool WHERE factory = ${a}`,
        prismaHistoricalRead.$queryRaw<Array<{ pool: string; version: string; other: string }>>`
          SELECT pool, version, CASE WHEN token0 = ${a} THEN token1 ELSE token0 END AS other
          FROM elysium_dex_pool WHERE token0 = ${a} OR token1 = ${a} ORDER BY created_at DESC LIMIT 10`,
        this.methodNames(prismaHistoricalRead),
        // Launchpad origin and holder spread, for tokens born on a launchpad we decode.
        prismaHistoricalRead.$queryRaw<
          Array<{ launchpad: string; kind: string; creator: string | null; created_at: number; graduated: boolean; holders: number | null; top10_pct: number | null; dev_pct: number | null }>
        >`
          SELECT launchpad, kind, creator, (extract(epoch FROM created_at) * 1000)::float8 AS created_at,
                 graduated_at IS NOT NULL AS graduated, holders, top10_pct, dev_pct
          FROM elysium_launch WHERE token = ${a}`,
      ]);

      const d = dep[0];
      let deployer: unknown = null;
      if (d) {
        const [count, siblings] = await Promise.all([
          prismaHistoricalRead.$queryRaw<Array<{ n: number; first: number | null }>>`
            SELECT count(*)::int AS n, (extract(epoch FROM min(deployed_at)) * 1000)::float8 AS first
            FROM elysium_contract WHERE deployer = ${d.deployer}`,
          prismaHistoricalRead.$queryRaw<Array<{ address: string; deployed_at: number; name: string | null; symbol: string | null; standard: string | null }>>`
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
          callers7d: callers7d.get(a) ?? 0,
          failed7d: usage[0]?.failed ?? 0,
          firstCall: iso(allTime[0]?.first ?? null),
          lastCall: iso(allTime[0]?.last ?? null),
          topMethods: methods.map((m) => ({ ...this.methodRef(m.method_id, names), txs: m.txs })),
        },
        launch: launch[0]
          ? {
              launchpad: launch[0].launchpad,
              kind: launch[0].kind,
              creator: launch[0].creator,
              at: iso(launch[0].created_at),
              graduated: launch[0].graduated,
              holders: launch[0].holders,
              top10Pct: launch[0].top10_pct,
              devPct: launch[0].dev_pct,
            }
          : null,
        dex: {
          pool: pool ? { factory: pool.factory, version: pool.version, token0: pool.token0, token1: pool.token1, fee: pool.fee } : null,
          factory: f && f.pools > 0 ? { pools: f.pools, version: f.version } : null,
          pools: inPools.map((p) => ({ pool: p.pool, version: p.version, pairedWith: p.other })),
        },
      };
    });
  }
}
