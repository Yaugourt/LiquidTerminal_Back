import { Prisma } from '../../../prisma-historical/generated/client';
import { prismaHistoricalAggregate } from '../../core/prisma.historical.service';
import { redisService } from '../../core/redis.service';
import { ViewResult, viewScheduler, type ViewCadence, type ViewDef } from '../../core/viewScheduler';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ELYSIUM_PROJECTS, ElysiumProject } from '../../constants/elysium-projects';
import { HYPE_QUOTES, quoteDecimals, USD_QUOTES } from './elysium-launchpad.util';
import { hashGrouped } from './elysium-rollup.reader';

const PROJECTS_KEY = 'elysium:ecosystem:projects:v5';
const ALL_TIME_KEY = 'elysium:ecosystem:alltime:v1';
/**
 * Computed by the view scheduler, never by a visit. The directory takes about
 * 23 s on prod (measured 2026-11-11) and its page polls every 2 min: every 2
 * min while watched, every 30 min otherwise. The all-time counts scan every tx
 * ever sent to a project: every 10 min while the directory is watched.
 */
const PROJECTS_CADENCE: ViewCadence = { activeS: 120, idleS: 1800, heavy: true };
const ALL_TIME_CADENCE: ViewCadence = { activeS: 600, idleS: 3600, heavy: true };
const VERIFIED_KEY = 'elysium:ecosystem:verified:v1';
const VERIFIED_TTL_MS = 6 * 3600_000;
/** Etherscan-style API of the Kinetiq explorer (testnet), where Elysium contracts get verified. */
const EXPLORER_API = 'https://elysium.kinetiq.xyz/api/';
const EXPLORER_CONCURRENCY = 4;
const PERP_MARKETS_CACHE_KEY = 'perp:markets';
const DAY_MS = 86_400_000;
/** Length of the daily active-user series, in rolling 24h buckets ending now. */
const SERIES_DAYS = 14;
/**
 * A call read from the RPC (elysium_tx_live, alias lv) that the provider's stream has not
 * stored. The views take the live rows after the stream's cursor, but that cursor is read before
 * the statement runs: the stream moves on meanwhile, and a call it had stored by then was in
 * both tables, counted twice until the next computation.
 */
const NOT_STORED = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM elysium_tx st
  WHERE st.tx_hash = lv.tx_hash
    -- The same transaction, so the same block: a day around it is all that has to be looked at
    -- (and not every day elysium_tx holds, once it is split by day).
    AND st.block_time >= lv.block_time - interval '1 day' AND st.block_time <= lv.block_time + interval '1 day')`;

/** USD value of one unit of a launch quote: the HYPE price for HYPE quotes, $1 for test USDC, else null. */
function quoteUsd(quote: string, hypeUsd: number | null): number | null {
  if (USD_QUOTES.includes(quote)) return 1;
  return HYPE_QUOTES.includes(quote) ? hypeUsd : null;
}

/** Raw quote amount (decimal string) to quote units. */
function quoteUnits(raw: string | null, quote: string): number {
  return raw ? Number(raw) / 10 ** quoteDecimals(quote) : 0;
}

export interface ElysiumProjectView extends Omit<ElysiumProject, 'contracts'> {
  contracts: number;
  /** Distinct wallets that sent a tx to one of the project's contracts over 7 days; null without contracts. */
  wallets7d: number | null;
  txs7d: number | null;
  /** Active users (distinct senders) over the last 24h and the 24h before; null without contracts. */
  users24h: number | null;
  usersPrev24h: number | null;
  /** Active users over the 7 days before the last 7. */
  usersPrev7d: number | null;
  /** Active users per rolling 24h bucket, oldest first, last bucket ending now; empty without contracts. */
  usersDaily: number[];
  /** Launchpads only: traded volume (USD) and tokens launched over 7 days. */
  volume7d: number | null;
  launches7d: number | null;
  /** Since the first block: non-spam txs and distinct wallets sent to the project's contracts; null without contracts. */
  txsAll: number | null;
  walletsAll: number | null;
  /** First non-spam tx to one of its contracts (ISO), null if none yet. */
  firstTxAt: string | null;
  /** Listed contracts with verified source on the explorer; null until the first check ran. */
  verifiedContracts: number | null;
}

/**
 * Activity the provider has not indexed yet. `from` is its tx cursor; `to` is where the RPC live
 * fallback (elysium_tx_live) picks up, null while it has not. Calls in between are missing.
 */
export interface ElysiumActivityGap {
  from: string;
  to: string | null;
}

/** Behind the clock by more than this, the provider's tx cursor counts as a gap. */
const GAP_MIN_MS = 10 * 60 * 1000;

interface AllTimeRow {
  slug: string;
  txs: number;
  wallets: number;
  /** Unix seconds. */
  first_at: number | null;
}

interface ActivityRow {
  slug: string;
  wallets: number;
  txs: number;
  wallets_prev7: number;
  wallets24: number;
  wallets_prev24: number;
}

/**
 * Elysium ecosystem directory and launchpad token market, computed from our
 * own Elysium tables (historical DB, chain data indexed by HypeDexer).
 * - Projects: 7-day activity = non-spam user txs sent to the project's listed
 *   contracts; launchpads also get their traded volume and launches.
 * (The launchpad token market itself is ElysiumLaunchpadMarketService.)
 * Served from the last value, refreshed in the background every 60s.
 */
export class ElysiumEcosystemService {
  private static instance: ElysiumEcosystemService;

  public static getInstance(): ElysiumEcosystemService {
    if (!ElysiumEcosystemService.instance) {
      ElysiumEcosystemService.instance = new ElysiumEcosystemService();
    }
    return ElysiumEcosystemService.instance;
  }

  public getProjects(): Promise<ViewResult<{ projects: ElysiumProjectView[]; activityGap: ElysiumActivityGap | null; computedAt: string }>> {
    // The directory shows the all-time counts: while it is watched, so are they.
    viewScheduler.watch(this.allTimeView());
    return viewScheduler.read(this.projectsView());
  }

  private projectsView(): ViewDef<{ projects: ElysiumProjectView[]; activityGap: ElysiumActivityGap | null; computedAt: string }> {
    return { key: PROJECTS_KEY, cadence: PROJECTS_CADENCE, compute: () => this.computeProjects() };
  }

  private allTimeView(): ViewDef<AllTimeRow[]> {
    return { key: ALL_TIME_KEY, cadence: ALL_TIME_CADENCE, compute: () => this.computeAllTime() };
  }

  /** Hands the scheduler the directory and its all-time counts, to be kept computed. */
  public registerDefaults(): void {
    viewScheduler.register(this.projectsView());
    viewScheduler.register(this.allTimeView());
  }

  private verifying = false;

  /**
   * All-time activity per project, a view of its own. Read from inside the
   * directory's computation: its last value, or computed there the first time.
   */
  private getAllTime(): Promise<AllTimeRow[]> {
    return viewScheduler.readOrCompute(this.allTimeView());
  }

  /**
   * Per project, since the first block: transactions, wallets, first transaction.
   *
   * The days folded for each contract come from elysium_project_wallet (one row per contract
   * and sender), the days after them from elysium_tx, and the calls the provider has not
   * indexed yet from the RPC's rows. It was a read of every transaction ever sent to a
   * project, longer with each day of history. One statement: the folded day of a contract and
   * its wallets are read as of the same instant, so no day is counted twice or left out.
   */
  private async computeAllTime(): Promise<AllTimeRow[]> {
    const pairs = ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => ({ slug: p.slug, addr: c.address })));
    const cursor = (await this.readTxCursor())?.toISOString() ?? null;
    // Where the contract furthest behind stands, read first: a floor that lets the statement
    // below read the days after it in one pass (each contract's own day, read by that statement,
    // is what decides which of its transactions are counted from elysium_tx).
    const floorRows = await prismaHistoricalAggregate.$queryRaw<Array<{ unfolded: number; floor: string | null }>>`
      SELECT count(*) FILTER (WHERE c.through_day IS NULL)::int AS unfolded,
             (min(c.through_day) - 1)::text AS floor
      FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS r(slug text, addr text)
      LEFT JOIN elysium_project_contract c ON c.to_addr = r.addr`;
    const floor =
      floorRows[0] && Number(floorRows[0].unfolded) === 0 && floorRows[0].floor
        ? `${floorRows[0].floor.slice(0, 10)}T00:00:00.000Z`
        : null;
    // Per project and sender first, then per project: count(DISTINCT sender) sorted every call
    // ever sent to a project, on disk.
    return hashGrouped(
      prismaHistoricalAggregate,
      (tx) => tx.$queryRaw<AllTimeRow[]>`
        WITH reg AS (
          SELECT r.slug, r.addr,
                 COALESCE(((c.through_day + 1)::timestamp AT TIME ZONE 'UTC'), '-infinity'::timestamptz) AS after
          FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS r(slug text, addr text)
          LEFT JOIN elysium_project_contract c ON c.to_addr = r.addr
        ),
        calls AS (
          SELECT reg.slug, w.from_addr, w.txs, w.first_at
          FROM reg JOIN elysium_project_wallet w ON w.to_addr = reg.addr
          UNION ALL
          SELECT reg.slug, t.from_addr, count(*), min(t.block_time)
          FROM reg
          JOIN elysium_tx t ON t.to_addr = reg.addr AND t.block_time >= reg.after
          WHERE NOT t.is_spam AND t.block_time >= COALESCE(${floor}::timestamptz, '-infinity'::timestamptz)
          GROUP BY reg.slug, t.from_addr
          UNION ALL
          -- A contract that stands before the floor after all (listed between the two reads):
          -- its days up to the floor. No contract in the usual case, and nothing read.
          SELECT reg.slug, t.from_addr, count(*), min(t.block_time)
          FROM reg
          JOIN elysium_tx t ON t.to_addr = reg.addr AND t.block_time >= reg.after AND t.block_time < ${floor}::timestamptz
          WHERE NOT t.is_spam AND reg.after < ${floor}::timestamptz
          GROUP BY reg.slug, t.from_addr
          UNION ALL
          SELECT reg.slug, lv.from_addr, count(*), min(lv.block_time)
          FROM reg
          JOIN elysium_tx_live lv ON lv.to_addr = reg.addr
          WHERE lv.block_time > COALESCE(${cursor}::timestamptz, 'infinity'::timestamptz)
            AND ${NOT_STORED}
          GROUP BY reg.slug, lv.from_addr
        )
        SELECT slug, sum(txs)::int AS txs, count(*)::int AS wallets, extract(epoch FROM min(first_at))::float8 AS first_at
        FROM (
          SELECT slug, from_addr, sum(txs) AS txs, min(first_at) AS first_at
          FROM calls
          GROUP BY slug, from_addr
        ) s GROUP BY slug`
    );
  }

  /**
   * Addresses with verified source, from the explorer. Never blocks the directory: a stale or
   * missing entry starts a background refresh and the last known set (or null) is served meanwhile.
   */
  private async readVerified(): Promise<Set<string> | null> {
    let entry: { at: number; addresses: string[] } | null = null;
    try {
      const raw = await redisService.get(VERIFIED_KEY);
      entry = raw ? (JSON.parse(raw) as { at: number; addresses: string[] }) : null;
    } catch {
      entry = null;
    }
    if ((!entry || Date.now() - entry.at > VERIFIED_TTL_MS) && !this.verifying) {
      this.verifying = true;
      void this.refreshVerified().finally(() => {
        this.verifying = false;
      });
    }
    return entry ? new Set(entry.addresses) : null;
  }

  private async refreshVerified(): Promise<void> {
    const addresses = [...new Set(ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => c.address)))];
    const verified: string[] = [];
    let failed = 0;
    for (let i = 0; i < addresses.length; i += EXPLORER_CONCURRENCY) {
      await Promise.all(
        addresses.slice(i, i + EXPLORER_CONCURRENCY).map(async (address) => {
          try {
            const res = await fetch(`${EXPLORER_API}?module=contract&action=getsourcecode&address=${address}`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as { result?: Array<{ ContractName?: string; SourceCode?: string }> };
            const hit = body.result?.[0];
            if (hit?.ContractName || hit?.SourceCode) verified.push(address);
          } catch {
            failed++;
          }
        })
      );
    }
    // A partial pass would undercount: keep the previous set if too many lookups failed.
    if (failed > addresses.length / 4) {
      logDeduplicator.warn('ElysiumEcosystemService: explorer verification lookups failed', { failed });
      return;
    }
    await redisService.set(VERIFIED_KEY, JSON.stringify({ at: Date.now(), addresses: verified }), 7 * 24 * 3600);
  }

  /** HYPE mid from the perp markets cache kept warm by the market pollers. */
  private async readHypeUsd(): Promise<number | null> {
    try {
      const raw = await redisService.get(PERP_MARKETS_CACHE_KEY);
      if (!raw) return null;
      const markets = JSON.parse(raw) as Array<{ name: string; price: number }>;
      const px = Number(markets.find((m) => m?.name === 'HYPE')?.price);
      return Number.isFinite(px) && px > 0 ? px : null;
    } catch (error) {
      logDeduplicator.warn('ElysiumEcosystemService: failed to read HYPE price', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  /** The provider's tx cursor: elysium_tx is complete up to it, elysium_tx_live takes over after. */
  private async readTxCursor(): Promise<Date | null> {
    // As epoch millis, like the repository does: a timestamp read as a Date through the pg
    // adapter comes back shifted by the session's UTC offset when the database session is not
    // in UTC (an hour off on a Europe/Paris session, measured 2026-11-11: the live rows of that
    // hour were then left out of every count).
    const rows = await prismaHistoricalAggregate.$queryRaw<Array<{ cursor_ms: number | null }>>`
      SELECT (extract(epoch FROM cursor) * 1000)::float8 AS cursor_ms FROM elysium_ingest_state WHERE stream = 'tx'`;
    const ms = rows[0]?.cursor_ms;
    return ms === null || ms === undefined ? null : new Date(Number(ms));
  }

  private async computeProjects(): Promise<{
    projects: ElysiumProjectView[];
    activityGap: ElysiumActivityGap | null;
    computedAt: string;
  }> {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
    const nowIso = now.toISOString();
    const [since1, since2, since7, since14] = [ago(1), ago(2), ago(7), ago(SERIES_DAYS)];
    const pairs = ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => ({ slug: p.slug, addr: c.address })));
    // Provider rows up to its tx cursor, RPC-read rows (no spam flag in that view) after it.
    const txCursor = await this.readTxCursor();
    const cursorIso = txCursor?.toISOString() ?? null;

    const [calls, pads, padVolumes, hypeUsd, allTime, verified] = await Promise.all([
      // The 14 days of calls to the project contracts, read once: per project, sender and
      // rolling 24-hour bucket (bucket 0 is the last 24h, so the latest one is never a partial
      // day), with the side of each boundary the call falls on. The window figures and the
      // daily series are then counted from those rows. They were two statements that each
      // read the 14 days and sorted them on disk for their distinct counts.
      hashGrouped(prismaHistoricalAggregate, async (tx) => {
        // Kept for the two counts below in a table of this transaction, not in a CTE, and the
        // provider's rows apart from the live ones: Postgres then reads elysium_tx with
        // several workers, and that read is what this view costs.
        //
        // No nested loop for the provider's rows: the planner expects a few rows per address
        // and looks each project contract up through the index, one after the other; together
        // they hold a fifth of the 14 days, read three times faster in one pass and hashed
        // (measured 2026-11-12).
        await tx.$executeRaw`SET LOCAL enable_nestloop = off`;
        await tx.$executeRaw`
          CREATE TEMP TABLE _elysium_project_calls ON COMMIT DROP AS
          SELECT reg.slug, t.from_addr,
                 floor(extract(epoch FROM (${nowIso}::timestamptz - t.block_time)) / 86400)::int AS bucket,
                 (t.block_time >= ${since7}::timestamptz) AS in7,
                 (t.block_time >= ${since1}::timestamptz) AS in1,
                 (t.block_time >= ${since2}::timestamptz AND t.block_time < ${since1}::timestamptz) AS in2,
                 (t.block_time <= ${nowIso}::timestamptz) AS past,
                 count(*) AS txs
          FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS reg(slug text, addr text)
          JOIN elysium_tx t ON t.to_addr = reg.addr
          WHERE t.block_time >= ${since14}::timestamptz AND NOT t.is_spam
          GROUP BY 1, 2, 3, 4, 5, 6, 7`;
        await tx.$executeRaw`SET LOCAL enable_nestloop = on`;
        // The calls read from the RPC after the provider's cursor (a small table): same columns.
        await tx.$executeRaw`
          INSERT INTO _elysium_project_calls
          SELECT reg.slug, lv.from_addr,
                 floor(extract(epoch FROM (${nowIso}::timestamptz - lv.block_time)) / 86400)::int,
                 (lv.block_time >= ${since7}::timestamptz),
                 (lv.block_time >= ${since1}::timestamptz),
                 (lv.block_time >= ${since2}::timestamptz AND lv.block_time < ${since1}::timestamptz),
                 (lv.block_time <= ${nowIso}::timestamptz),
                 count(*)
          FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS reg(slug text, addr text)
          JOIN elysium_tx_live lv ON lv.to_addr = reg.addr
          WHERE lv.block_time >= ${since14}::timestamptz
            AND lv.block_time > COALESCE(${cursorIso}::timestamptz, 'infinity'::timestamptz)
            AND ${NOT_STORED}
          GROUP BY 1, 2, 3, 4, 5, 6, 7`;
        const activity = await tx.$queryRaw<ActivityRow[]>`
          SELECT slug, count(*) FILTER (WHERE in7)::int AS wallets, COALESCE(sum(txs7), 0)::int AS txs,
                 count(*) FILTER (WHERE prev7)::int AS wallets_prev7,
                 count(*) FILTER (WHERE in1)::int AS wallets24, count(*) FILTER (WHERE in2)::int AS wallets_prev24
          FROM (
            -- One row per project and sender: which windows it sent in.
            SELECT slug, bool_or(in7) AS in7, bool_or(NOT in7) AS prev7, bool_or(in1) AS in1, bool_or(in2) AS in2,
                   sum(txs) FILTER (WHERE in7) AS txs7
            FROM _elysium_project_calls GROUP BY slug, from_addr
          ) s GROUP BY slug`;
        const daily = await tx.$queryRaw<Array<{ slug: string; bucket: number; users: number }>>`
          SELECT slug, bucket, count(*)::int AS users FROM (
            SELECT slug, bucket FROM _elysium_project_calls WHERE past GROUP BY slug, bucket, from_addr
          ) d GROUP BY slug, bucket`;
        return { activity, daily };
      }),
      prismaHistoricalAggregate.$queryRaw<Array<{ launchpad: string; launches: number }>>`
        SELECT l.launchpad, count(*) FILTER (WHERE l.created_at >= ${since7}::timestamptz)::int AS launches
        FROM elysium_launch l
        GROUP BY l.launchpad`,
      // Per quote, since a launchpad can price tokens in HYPE and in test USDC (Neuriio).
      prismaHistoricalAggregate.$queryRaw<Array<{ launchpad: string; quote: string; volume: string | null }>>`
        SELECT l.launchpad, l.quote, sum(tr.quote_amount)::text AS volume
        FROM elysium_launch_trade tr
        JOIN elysium_launch l ON l.token = tr.token
        WHERE tr.block_time >= ${since7}::timestamptz
        GROUP BY l.launchpad, l.quote`,
      this.readHypeUsd(),
      this.getAllTime(),
      this.readVerified(),
    ]);
    const activityGap = await this.readActivityGap(txCursor, now);
    const { activity, daily } = calls;

    const allBySlug = new Map(allTime.map((r) => [r.slug, r]));
    const bySlug = new Map(activity.map((r) => [r.slug, r]));
    const byPad = new Map(pads.map((r) => [r.launchpad, r]));
    // USD volume per launchpad. Trades on quotes we cannot value are left out; a HYPE quote
    // without a HYPE price makes the whole figure unknown rather than understated.
    const padUsd = new Map<string, number | null>();
    for (const r of padVolumes) {
      if (!HYPE_QUOTES.includes(r.quote) && !USD_QUOTES.includes(r.quote)) continue;
      const usd = quoteUsd(r.quote, hypeUsd);
      const prev = padUsd.has(r.launchpad) ? padUsd.get(r.launchpad)! : 0;
      padUsd.set(r.launchpad, prev === null || usd === null ? null : prev + quoteUnits(r.volume, r.quote) * usd);
    }
    const series = new Map<string, number[]>();
    for (const r of daily) {
      if (r.bucket < 0 || r.bucket >= SERIES_DAYS) continue;
      const arr = series.get(r.slug) ?? new Array<number>(SERIES_DAYS).fill(0);
      arr[SERIES_DAYS - 1 - r.bucket] = r.users;
      series.set(r.slug, arr);
    }
    const projects = ELYSIUM_PROJECTS.map(({ contracts, ...p }) => {
      const hit = bySlug.get(p.slug);
      const firstAt = allBySlug.get(p.slug)?.first_at ?? null;
      const has = contracts.length > 0;
      const pad = p.launchpad ? byPad.get(p.launchpad) : undefined;
      const volume = p.launchpad ? padUsd.get(p.launchpad) : undefined;
      return {
        ...p,
        contracts: contracts.length,
        wallets7d: has ? (hit?.wallets ?? 0) : null,
        txs7d: has ? (hit?.txs ?? 0) : null,
        users24h: has ? (hit?.wallets24 ?? 0) : null,
        usersPrev24h: has ? (hit?.wallets_prev24 ?? 0) : null,
        usersPrev7d: has ? (hit?.wallets_prev7 ?? 0) : null,
        usersDaily: has ? (series.get(p.slug) ?? new Array<number>(SERIES_DAYS).fill(0)) : [],
        volume7d: p.launchpad ? (volume === undefined ? (hypeUsd === null ? null : 0) : volume) : null,
        launches7d: p.launchpad ? (pad?.launches ?? 0) : null,
        txsAll: has ? (allBySlug.get(p.slug)?.txs ?? 0) : null,
        walletsAll: has ? (allBySlug.get(p.slug)?.wallets ?? 0) : null,
        firstTxAt: firstAt ? new Date(firstAt * 1000).toISOString() : null,
        verifiedContracts: verified ? contracts.filter((c) => verified.has(c.address)).length : null,
      };
    });
    return { projects, activityGap, computedAt: now.toISOString() };
  }

  /** The window with no activity data: from the provider's tx cursor to where the live fallback began. */
  private async readActivityGap(txCursor: Date | null, now: Date): Promise<ElysiumActivityGap | null> {
    if (!txCursor || now.getTime() - txCursor.getTime() < GAP_MIN_MS) return null;
    const rows = await prismaHistoricalAggregate.$queryRaw<Array<{ start_ms: number | null }>>`
      SELECT (extract(epoch FROM min(block_time)) * 1000)::float8 AS start_ms
      FROM elysium_tx_live WHERE block_time > ${txCursor.toISOString()}::timestamptz`;
    const startMs = rows[0]?.start_ms;
    return { from: txCursor.toISOString(), to: startMs === null || startMs === undefined ? null : new Date(Number(startMs)).toISOString() };
  }
}
