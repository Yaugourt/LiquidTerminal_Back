import { prismaHistorical } from '../../core/prisma.historical.service';
import { cacheService } from '../../core/cache.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ELYSIUM_PROJECTS, ElysiumProject } from '../../constants/elysium-projects';
import { CURVE_SALE_SUPPLY, HYPE_QUOTES, LAUNCH_TOTAL_SUPPLY } from './elysium-launchpad.util';

const CACHE_TTL_S = 60;
/** How long a computed value is kept to be served while it refreshes. */
const KEEP_S = 6 * 3600;
const PROJECTS_KEY = 'elysium:ecosystem:projects:v3';
const TOKENS_KEY = 'elysium:ecosystem:launchpads:v1';
const PERP_MARKETS_CACHE_KEY = 'perp:markets';
const DAY_MS = 86_400_000;
/** Length of the daily active-user series, in rolling 24h buckets ending now. */
const SERIES_DAYS = 14;
const WEI = 1e18;

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

  public getProjects(): Promise<{ projects: ElysiumProjectView[]; computedAt: string }> {
    return cacheService.getOrRefresh(PROJECTS_KEY, () => this.computeProjects(), CACHE_TTL_S, KEEP_S);
  }

  public getLaunchpadTokens(): Promise<{ tokens: ElysiumLaunchTokenView[]; hypeUsd: number | null; computedAt: string }> {
    return cacheService.getOrRefresh(TOKENS_KEY, () => this.computeTokens(), CACHE_TTL_S, KEEP_S);
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

  private async computeProjects(): Promise<{ projects: ElysiumProjectView[]; computedAt: string }> {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
    const nowIso = now.toISOString();
    const [since1, since2, since7, since14] = [ago(1), ago(2), ago(7), ago(SERIES_DAYS)];
    const pairs = ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => ({ slug: p.slug, addr: c.address })));

    const [activity, daily, pads, hypeUsd] = await Promise.all([
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
        JOIN elysium_tx t ON t.to_addr = reg.addr AND t.block_time >= ${since14}::timestamptz AND NOT t.is_spam
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
        JOIN elysium_tx t ON t.to_addr = reg.addr AND t.block_time >= ${since14}::timestamptz
                         AND t.block_time <= ${nowIso}::timestamptz AND NOT t.is_spam
        GROUP BY 1, 2`,
      prismaHistorical.$queryRaw<Array<{ launchpad: string; volume: string | null; launches: number }>>`
        SELECT l.launchpad,
               (SELECT sum(tr.quote_amount) FROM elysium_launch_trade tr
                  JOIN elysium_launch l2 ON l2.token = tr.token
                 WHERE l2.launchpad = l.launchpad AND l2.quote = ANY(${HYPE_QUOTES}::text[])
                   AND tr.block_time >= ${since7}::timestamptz)::text AS volume,
               count(*) FILTER (WHERE l.created_at >= ${since7}::timestamptz)::int AS launches
        FROM elysium_launch l
        GROUP BY l.launchpad`,
      this.readHypeUsd(),
    ]);

    const bySlug = new Map(activity.map((r) => [r.slug, r]));
    const byPad = new Map(pads.map((r) => [r.launchpad, r]));
    const series = new Map<string, number[]>();
    for (const r of daily) {
      if (r.bucket < 0 || r.bucket >= SERIES_DAYS) continue;
      const arr = series.get(r.slug) ?? new Array<number>(SERIES_DAYS).fill(0);
      arr[SERIES_DAYS - 1 - r.bucket] = r.users;
      series.set(r.slug, arr);
    }
    const projects = ELYSIUM_PROJECTS.map(({ contracts, ...p }) => {
      const hit = bySlug.get(p.slug);
      const has = contracts.length > 0;
      const pad = p.launchpad ? byPad.get(p.launchpad) : undefined;
      const volumeHype = pad?.volume ? Number(pad.volume) / WEI : 0;
      return {
        ...p,
        contracts: contracts.length,
        wallets7d: has ? (hit?.wallets ?? 0) : null,
        txs7d: has ? (hit?.txs ?? 0) : null,
        users24h: has ? (hit?.wallets24 ?? 0) : null,
        usersPrev24h: has ? (hit?.wallets_prev24 ?? 0) : null,
        usersPrev7d: has ? (hit?.wallets_prev7 ?? 0) : null,
        usersDaily: has ? (series.get(p.slug) ?? new Array<number>(SERIES_DAYS).fill(0)) : [],
        volume7d: p.launchpad && hypeUsd !== null ? volumeHype * hypeUsd : null,
        launches7d: p.launchpad ? (pad?.launches ?? 0) : null,
      };
    });
    return { projects, computedAt: now.toISOString() };
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
      // Only HYPE-quoted launches get a USD value; anything else stays unpriced.
      const usd = HYPE_QUOTES.includes(r.quote) ? hypeUsd : null;
      const priceUsd = r.price !== null && usd !== null ? r.price * usd : null;
      const change24h = r.price !== null && r.price_24h ? (r.price / r.price_24h - 1) * 100 : null;
      const sale = r.launchpad === 'CorePad' || r.launchpad === 'Signal' ? CURVE_SALE_SUPPLY[r.launchpad] : null;
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
        volume24h: usd !== null ? (r.vol24 ? (Number(r.vol24) / WEI) * usd : 0) : null,
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
