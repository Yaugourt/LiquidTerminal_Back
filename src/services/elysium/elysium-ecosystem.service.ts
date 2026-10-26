import { prismaHistorical } from '../../core/prisma.historical.service';
import { cacheService } from '../../core/cache.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ELYSIUM_PROJECTS, ElysiumProject } from '../../constants/elysium-projects';
import { CURVE_SALE_SUPPLY, HYPE_QUOTES, LAUNCH_TOTAL_SUPPLY, Launchpad, quoteDecimals, USD_QUOTES } from './elysium-launchpad.util';

const CACHE_TTL_S = 60;
/** How long a computed value is kept to be served while it refreshes. */
const KEEP_S = 6 * 3600;
const PROJECTS_KEY = 'elysium:ecosystem:projects:v5';
const ALL_TIME_KEY = 'elysium:ecosystem:alltime:v1';
/** All-time counts scan every tx ever sent to a project: refreshed every 10 min, not every minute. */
const ALL_TIME_TTL_S = 600;
const VERIFIED_KEY = 'elysium:ecosystem:verified:v1';
const VERIFIED_TTL_MS = 6 * 3600_000;
/** Etherscan-style API of the Kinetiq explorer (testnet), where Elysium contracts get verified. */
const EXPLORER_API = 'https://elysium.kinetiq.xyz/api/';
const EXPLORER_CONCURRENCY = 4;
const TOKENS_KEY = 'elysium:ecosystem:launchpads:v1';
const PERP_MARKETS_CACHE_KEY = 'perp:markets';
const DAY_MS = 86_400_000;
/** Length of the daily active-user series, in rolling 24h buckets ending now. */
const SERIES_DAYS = 14;

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

export interface ElysiumLaunchTokenView {
  address: string;
  symbol: string;
  name: string;
  launchpad: string;
  creator: string | null;
  priceUsd: number | null;
  /** Percent change of the last price against the last price 24h ago. */
  change24h: number | null;
  volume24h: number | null;
  txns24h: number;
  traders24h: number;
  holders: number | null;
  /** Price x total supply (every launch mints 1B tokens). */
  marketCap: number | null;
  top10Pct: number | null;
  devPct: number | null;
  /** Bonding-curve progress in percent; null for tokens that trade in a pool. */
  curvePct: number | null;
  /** Unix seconds. */
  bornAt: number;
  graduated: boolean;
}

interface ActivityRow {
  slug: string;
  wallets: number;
  txs: number;
  wallets_prev7: number;
  wallets24: number;
  wallets_prev24: number;
}

interface TokenSqlRow {
  token: string;
  launchpad: string;
  kind: string;
  creator: string | null;
  symbol: string | null;
  name: string | null;
  quote: string;
  born: number;
  graduated: boolean;
  holders: number | null;
  top10_pct: number | null;
  dev_pct: number | null;
  price: number | null;
  price_24h: number | null;
  vol24: string | null;
  txns24: number | null;
  traders24: number | null;
  sold: string | null;
}

/**
 * Elysium ecosystem directory and launchpad token market, computed from our
 * own Elysium tables (historical DB, chain data indexed by HypeDexer).
 * - Projects: 7-day activity = non-spam user txs sent to the project's listed
 *   contracts; launchpads also get their traded volume and launches.
 * - Tokens: every launch decoded from the launchpads' own events, priced from
 *   their last trade, valued at the current HYPE price.
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

  public getProjects(): Promise<{ projects: ElysiumProjectView[]; activityGap: ElysiumActivityGap | null; computedAt: string }> {
    return cacheService.getOrRefresh(PROJECTS_KEY, () => this.computeProjects(), CACHE_TTL_S, KEEP_S);
  }

  public getLaunchpadTokens(): Promise<{ tokens: ElysiumLaunchTokenView[]; hypeUsd: number | null; computedAt: string }> {
    return cacheService.getOrRefresh(TOKENS_KEY, () => this.computeTokens(), CACHE_TTL_S, KEEP_S);
  }

  private verifying = false;

  /** All-time activity per project, cached apart from the 60s refresh. */
  private getAllTime(): Promise<AllTimeRow[]> {
    return cacheService.getOrRefresh(ALL_TIME_KEY, () => this.computeAllTime(), ALL_TIME_TTL_S, KEEP_S);
  }

  private async computeAllTime(): Promise<AllTimeRow[]> {
    const pairs = ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => ({ slug: p.slug, addr: c.address })));
    const cursor = (await this.readTxCursor())?.toISOString() ?? null;
    return prismaHistorical.$queryRaw<AllTimeRow[]>`
      WITH reg AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS r(slug text, addr text)
      ),
      calls AS (
        SELECT from_addr, to_addr, block_time FROM elysium_tx WHERE NOT is_spam
        UNION ALL
        SELECT from_addr, to_addr, block_time FROM elysium_tx_live
        WHERE block_time > COALESCE(${cursor}::timestamptz, 'infinity'::timestamptz)
      )
      SELECT reg.slug, count(*)::int AS txs, count(DISTINCT t.from_addr)::int AS wallets,
             extract(epoch FROM min(t.block_time))::float8 AS first_at
      FROM reg
      JOIN calls t ON t.to_addr = reg.addr
      GROUP BY reg.slug`;
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
    const rows = await prismaHistorical.$queryRaw<Array<{ cursor: Date | null }>>`
      SELECT cursor FROM elysium_ingest_state WHERE stream = 'tx'`;
    return rows[0]?.cursor ?? null;
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

    const [activity, daily, pads, padVolumes, hypeUsd, allTime, verified] = await Promise.all([
      prismaHistorical.$queryRaw<ActivityRow[]>`
        WITH reg AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS r(slug text, addr text)
        )
        SELECT reg.slug,
               count(DISTINCT t.from_addr) FILTER (WHERE t.block_time >= ${since7}::timestamptz)::int AS wallets,
               count(*) FILTER (WHERE t.block_time >= ${since7}::timestamptz)::int AS txs,
               count(DISTINCT t.from_addr) FILTER (WHERE t.block_time < ${since7}::timestamptz)::int AS wallets_prev7,
               count(DISTINCT t.from_addr) FILTER (WHERE t.block_time >= ${since1}::timestamptz)::int AS wallets24,
               count(DISTINCT t.from_addr) FILTER (WHERE t.block_time >= ${since2}::timestamptz
                                                     AND t.block_time < ${since1}::timestamptz)::int AS wallets_prev24
        FROM reg
        JOIN (
          SELECT from_addr, to_addr, block_time FROM elysium_tx
          WHERE block_time >= ${since14}::timestamptz AND NOT is_spam
          UNION ALL
          SELECT from_addr, to_addr, block_time FROM elysium_tx_live
          WHERE block_time >= ${since14}::timestamptz
            AND block_time > COALESCE(${cursorIso}::timestamptz, 'infinity'::timestamptz)
        ) t ON t.to_addr = reg.addr
        GROUP BY reg.slug`,
      // Bucket 0 is the last 24h; buckets are rolling so the latest one is never a partial day.
      prismaHistorical.$queryRaw<Array<{ slug: string; bucket: number; users: number }>>`
        WITH reg AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS r(slug text, addr text)
        )
        SELECT reg.slug,
               floor(extract(epoch FROM (${nowIso}::timestamptz - t.block_time)) / 86400)::int AS bucket,
               count(DISTINCT t.from_addr)::int AS users
        FROM reg
        JOIN (
          SELECT from_addr, to_addr, block_time FROM elysium_tx
          WHERE block_time >= ${since14}::timestamptz AND block_time <= ${nowIso}::timestamptz AND NOT is_spam
          UNION ALL
          SELECT from_addr, to_addr, block_time FROM elysium_tx_live
          WHERE block_time >= ${since14}::timestamptz AND block_time <= ${nowIso}::timestamptz
            AND block_time > COALESCE(${cursorIso}::timestamptz, 'infinity'::timestamptz)
        ) t ON t.to_addr = reg.addr
        GROUP BY 1, 2`,
      prismaHistorical.$queryRaw<Array<{ launchpad: string; launches: number }>>`
        SELECT l.launchpad, count(*) FILTER (WHERE l.created_at >= ${since7}::timestamptz)::int AS launches
        FROM elysium_launch l
        GROUP BY l.launchpad`,
      // Per quote, since a launchpad can price tokens in HYPE and in test USDC (Neuriio).
      prismaHistorical.$queryRaw<Array<{ launchpad: string; quote: string; volume: string | null }>>`
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
    const rows = await prismaHistorical.$queryRaw<Array<{ start: Date | null }>>`
      SELECT min(block_time) AS start FROM elysium_tx_live WHERE block_time > ${txCursor.toISOString()}::timestamptz`;
    const start = rows[0]?.start ?? null;
    return { from: txCursor.toISOString(), to: start ? start.toISOString() : null };
  }

  private async computeTokens(): Promise<{ tokens: ElysiumLaunchTokenView[]; hypeUsd: number | null; computedAt: string }> {
    const now = new Date();
    const since = new Date(now.getTime() - DAY_MS).toISOString();

    const [rows, hypeUsd] = await Promise.all([
      prismaHistorical.$queryRaw<TokenSqlRow[]>`
        WITH last AS (
          SELECT DISTINCT ON (token) token, price FROM elysium_launch_trade
          ORDER BY token, block_number DESC, log_index DESC
        ), before AS (
          SELECT DISTINCT ON (token) token, price FROM elysium_launch_trade
          WHERE block_time < ${since}::timestamptz
          ORDER BY token, block_number DESC, log_index DESC
        ), day AS (
          -- V4 swaps only see the router: the trader is the tx sender.
          SELECT tr.token, sum(tr.quote_amount)::text AS vol24, count(*)::int AS txns24,
                 count(DISTINCT coalesce(tr.trader, t.from_addr))::int AS traders24
          FROM elysium_launch_trade tr
          LEFT JOIN elysium_tx t ON t.tx_hash = tr.tx_hash AND tr.trader IS NULL
          WHERE tr.block_time >= ${since}::timestamptz
          GROUP BY tr.token
        ), curve AS (
          SELECT token, sum(CASE WHEN is_buy THEN token_amount ELSE -token_amount END)::text AS sold
          FROM elysium_launch_trade WHERE venue = 'curve'
          GROUP BY token
        )
        SELECT l.token, l.launchpad, l.kind, coalesce(l.creator, tx.from_addr) AS creator,
               coalesce(l.symbol, tk.symbol) AS symbol, coalesce(l.name, tk.name) AS name, l.quote,
               (extract(epoch FROM l.created_at))::float8 AS born, l.graduated_at IS NOT NULL AS graduated,
               l.holders, l.top10_pct, l.dev_pct,
               last.price, before.price AS price_24h, day.vol24, day.txns24, day.traders24, curve.sold
        FROM elysium_launch l
        LEFT JOIN elysium_tx tx ON tx.tx_hash = l.tx_hash
        LEFT JOIN elysium_token tk ON tk.address = l.token
        LEFT JOIN last ON last.token = l.token
        LEFT JOIN before ON before.token = l.token
        LEFT JOIN day ON day.token = l.token
        LEFT JOIN curve ON curve.token = l.token`,
      this.readHypeUsd(),
    ]);

    const tokens = rows.map((r): ElysiumLaunchTokenView => {
      // HYPE-quoted launches are valued at the HYPE price, test-USDC ones at $1; anything else stays unpriced.
      const usd = quoteUsd(r.quote, hypeUsd);
      const priceUsd = r.price !== null && usd !== null ? r.price * usd : null;
      const change24h = r.price !== null && r.price_24h ? (r.price / r.price_24h - 1) * 100 : null;
      const sale = CURVE_SALE_SUPPLY[r.launchpad as Launchpad] ?? null;
      let curvePct: number | null = null;
      if (r.kind === 'curve' && sale) {
        curvePct = r.graduated ? 100 : Math.max(0, Math.min(100, (Number(r.sold ?? 0) / Number(sale)) * 100));
      }
      return {
        address: r.token,
        symbol: r.symbol ?? r.token.slice(0, 8),
        name: r.name ?? '',
        launchpad: r.launchpad,
        creator: r.creator,
        priceUsd,
        change24h,
        volume24h: usd !== null ? quoteUnits(r.vol24, r.quote) * usd : null,
        txns24h: r.txns24 ?? 0,
        traders24h: r.traders24 ?? 0,
        holders: r.holders,
        marketCap: priceUsd !== null ? priceUsd * LAUNCH_TOTAL_SUPPLY : null,
        top10Pct: r.top10_pct,
        devPct: r.dev_pct,
        curvePct,
        bornAt: Math.round(r.born),
        graduated: r.graduated,
      };
    });
    return { tokens, hypeUsd, computedAt: now.toISOString() };
  }
}
