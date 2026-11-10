import { Prisma } from '../../../prisma-historical/generated/client';
import { prismaHistorical } from '../../core/prisma.historical.service';
import { redisService } from '../../core/redis.service';
import type { LaunchpadSort } from '../../schemas/elysium-analytics.schema';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { CURVE_SALE_SUPPLY, HYPE_QUOTES, LAUNCH_TOTAL_SUPPLY, Launchpad, quoteDecimals, USD_QUOTES } from './elysium-launchpad.util';

const PERP_MARKETS_CACHE_KEY = 'perp:markets';
const DAY_MS = 86_400_000;

/** The snapshot (what moved over 24h, the totals) is served for this long before it is refreshed. */
const SNAPSHOT_FRESH_MS = 60_000;
/** Rows of the mini lists (hot, gainers, just launched). */
const TOP_N = 5;
/** A $1 trade moves a near-empty curve by four digits: gainers need real volume to count. */
const GAINER_MIN_VOLUME = 100;
/** Matches a search sorts; past it the newest matches are kept and the total says so. */
const SEARCH_MAX_MATCHES = 5_000;
/** Searches computed at once, and how many may wait for a turn. */
const SEARCH_CONCURRENCY = 3;
const SEARCH_MAX_WAITING = 30;
const PAGE_TIMEOUT_MS = 8_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
/** Pages kept for the snapshot they were built from. */
const PAGE_CACHE_MAX = 300;
/** After a failed snapshot refresh, the next attempt waits this long (the last snapshot is served meanwhile). */
const SNAPSHOT_RETRY_MS = 15_000;


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

export interface ElysiumLaunchpadSummary {
  tokens: number;
  /** Launched over the 24h before `computedAt`. */
  launched24h: number;
  /** USD traded and trades over the same 24h. */
  volume24h: number;
  trades24h: number;
  graduated: number;
  /** Tokens per launchpad, largest first. */
  pads: Array<{ launchpad: string; tokens: number }>;
}

export interface ElysiumLaunchpadPage {
  /** The first `limit` tokens of the requested order. */
  tokens: ElysiumLaunchTokenView[];
  /** Tokens the filters match in all. */
  total: number;
  /** True when a search matched more than it sorts: `total` is then a floor, and the order covers the newest matches. */
  totalCapped: boolean;
  summary: ElysiumLaunchpadSummary;
  top: { hot: ElysiumLaunchTokenView[]; gainers: ElysiumLaunchTokenView[]; fresh: ElysiumLaunchTokenView[] };
  hypeUsd: number | null;
  computedAt: string;
}

export interface ElysiumLaunchpadQuery {
  pad?: string;
  sort: LaunchpadSort;
  q?: string;
  limit: number;
}

/** Too many searches are already waiting for a turn. */
export class LaunchpadSearchBusyError extends Error {
  public readonly retryAfterS = 1;
  constructor() {
    super('ELYSIUM_LAUNCHPAD_SEARCH_BUSY');
    this.name = 'LaunchpadSearchBusyError';
  }
}

/** A launch row as the queries below return it. */
interface LaunchSqlRow {
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
  sold: string | null;
}

/** The same, with what the token did over the last 24h. */
interface ActiveSqlRow extends LaunchSqlRow {
  price_24h: number | null;
  vol24: string | null;
  txns24: number;
  traders24: number;
}

interface Snapshot {
  at: number;
  since: Date;
  hypeUsd: number | null;
  /** Tokens traded over the last 24h, by address. Every other token has no volume and a flat price. */
  active: Map<string, ElysiumLaunchTokenView>;
  /** The active tokens in the "hot" order. */
  hot: ElysiumLaunchTokenView[];
  /** The active tokens by 24h change, largest first, unknown changes last. */
  gainers: ElysiumLaunchTokenView[];
  perPad: Map<string, { tokens: number; graduated: number; launched24h: number }>;
  summary: ElysiumLaunchpadSummary;
  top: ElysiumLaunchpadPage['top'];
}

/** USD value of one unit of a launch quote: the HYPE price for HYPE quotes, $1 for test USDC, else null. */
function quoteUsd(quote: string, hypeUsd: number | null): number | null {
  if (USD_QUOTES.includes(quote)) return 1;
  return HYPE_QUOTES.includes(quote) ? hypeUsd : null;
}

/** Raw quote amount (decimal string) to quote units. */
function quoteUnits(raw: string | null, quote: string): number {
  return raw ? Number(raw) / 10 ** quoteDecimals(quote) : 0;
}

const byAddress = (a: ElysiumLaunchTokenView, b: ElysiumLaunchTokenView): number => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

/** The page's orders, as comparators. Ties fall to the newest token, then the address, so an order is total. */
export function launchTokenSorter(sort: LaunchpadSort): (a: ElysiumLaunchTokenView, b: ElysiumLaunchTokenView) => number {
  const tie = (a: ElysiumLaunchTokenView, b: ElysiumLaunchTokenView): number => b.bornAt - a.bornAt || byAddress(a, b);
  switch (sort) {
    case 'new':
      return tie;
    case 'gainers':
      return (a, b) => {
        const x = a.change24h ?? -Infinity;
        const y = b.change24h ?? -Infinity;
        return (x === y ? 0 : y > x ? 1 : -1) || tie(a, b);
      };
    case 'mcap':
      return (a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) || tie(a, b);
    default:
      return (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0) || b.txns24h - a.txns24h || tie(a, b);
  }
}

/** Builds the public view of a launch; `day` is what it did over the last 24h, absent for a token that did not trade. */
export function toLaunchTokenView(
  r: LaunchSqlRow,
  hypeUsd: number | null,
  day?: { price_24h: number | null; vol24: string | null; txns24: number; traders24: number }
): ElysiumLaunchTokenView {
  // HYPE-quoted launches are valued at the HYPE price, test-USDC ones at $1; anything else stays unpriced.
  const usd = quoteUsd(r.quote, hypeUsd);
  const priceUsd = r.price !== null && usd !== null ? r.price * usd : null;
  // A token that did not trade over 24h still has its last price from before: flat.
  const price24h = day ? day.price_24h : r.price;
  const change24h = r.price !== null && price24h ? (r.price / price24h - 1) * 100 : null;
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
    volume24h: usd !== null ? quoteUnits(day?.vol24 ?? null, r.quote) * usd : null,
    txns24h: day?.txns24 ?? 0,
    traders24h: day?.traders24 ?? 0,
    holders: r.holders,
    marketCap: priceUsd !== null ? priceUsd * LAUNCH_TOTAL_SUPPLY : null,
    top10Pct: r.top10_pct,
    devPct: r.dev_pct,
    curvePct,
    bornAt: Math.round(r.born),
    graduated: r.graduated,
  };
}

/** `q` as an ILIKE pattern matching it anywhere, its own wildcards taken literally. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The columns of a launch row; `creator` falls back to the launch tx sender, names to the token registry. */
const LAUNCH_COLUMNS = Prisma.sql`
  l.token, l.launchpad, l.kind, coalesce(l.creator, tx.from_addr) AS creator,
  coalesce(l.symbol, tk.symbol) AS symbol, coalesce(l.name, tk.name) AS name, l.quote,
  (extract(epoch FROM l.created_at))::float8 AS born, l.graduated_at IS NOT NULL AS graduated,
  l.holders, l.top10_pct, l.dev_pct, l.curve_sold::text AS sold`;
const LAUNCH_JOINS = Prisma.sql`
  LEFT JOIN elysium_tx tx ON tx.tx_hash = l.tx_hash AND l.creator IS NULL
  LEFT JOIN elysium_token tk ON tk.address = l.token AND (l.symbol IS NULL OR l.name IS NULL)`;

/**
 * Launchpad token market: every token launched on the Elysium launchpads, one
 * page at a time.
 *
 * The route used to rebuild and return every token (420,705 of them, 168 MB of
 * JSON, on 2026-11-10) to sort and filter in the browser. Two facts make a page
 * cheap instead:
 * - only the tokens traded over the last 24h (about a thousand) have a volume,
 *   a change or traders; they are read once a minute into a snapshot held in
 *   this process, with the totals. Every other token is flat with no volume;
 * - the rest of what a row shows, and what the page sorts on, is kept on the
 *   launch row by the ingestion (last price, curve sold), so the other tokens
 *   come out of elysium_launch through its indexes, already in order.
 * A page is the head of an order: the active tokens that belong first, then as
 * many of the others as it takes. A search sorts its matches in memory.
 */
export class ElysiumLaunchpadMarketService {
  private static instance: ElysiumLaunchpadMarketService;

  private snapshot: Snapshot | null = null;
  private refreshing: Promise<Snapshot> | null = null;
  private refreshFailedAt = 0;
  /** Pages of the current snapshot, by request key; cleared when the snapshot changes. */
  private pages = new Map<string, Promise<Omit<ElysiumLaunchpadPage, 'summary' | 'top' | 'hypeUsd' | 'computedAt'>>>();
  private searching = 0;
  private searchWaiters: Array<() => void> = [];

  public static getInstance(): ElysiumLaunchpadMarketService {
    if (!ElysiumLaunchpadMarketService.instance) {
      ElysiumLaunchpadMarketService.instance = new ElysiumLaunchpadMarketService();
    }
    return ElysiumLaunchpadMarketService.instance;
  }

  /** One statement on its own connection with a time limit: a slow plan ends instead of holding the pool. */
  private timed<T>(ms: number, query: Prisma.Sql): Promise<T[]> {
    // Prisma's own transaction limit (5 s by default) is set just past the statement's.
    return prismaHistorical.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.trunc(ms)}`);
        return tx.$queryRaw<T[]>(query);
      },
      { timeout: ms + 2_000, maxWait: 5_000 }
    );
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
      logDeduplicator.warn('ElysiumLaunchpadMarketService: failed to read HYPE price', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot: the active tokens and the totals, once a minute
  // ---------------------------------------------------------------------------

  /**
   * The current snapshot. The first caller waits for it; after that the last
   * one is served while a newer one is computed (one at a time), and kept if
   * that fails.
   */
  private getSnapshot(): Promise<Snapshot> {
    const current = this.snapshot;
    if (current && Date.now() - current.at < SNAPSHOT_FRESH_MS) return Promise.resolve(current);
    if (current && Date.now() - this.refreshFailedAt < SNAPSHOT_RETRY_MS) return Promise.resolve(current);
    if (!this.refreshing) {
      this.refreshing = this.computeSnapshot()
        .then((next) => {
          this.snapshot = next;
          this.pages.clear();
          return next;
        })
        .finally(() => {
          this.refreshing = null;
        });
      // Served stale meanwhile: a failed refresh must not surface as an unhandled rejection.
      if (current) {
        this.refreshing.catch((error: unknown) => {
          this.refreshFailedAt = Date.now();
          logDeduplicator.warn('ElysiumLaunchpadMarketService: snapshot refresh failed', {
            errorType: error instanceof Error ? error.name : typeof error,
          });
        });
      }
    }
    return current ? Promise.resolve(current) : this.refreshing;
  }

  /** Computes the snapshot now if there is none (warm-up after a start). */
  public async warm(): Promise<void> {
    await this.getSnapshot();
  }

  private async computeSnapshot(): Promise<Snapshot> {
    const now = new Date(Date.now());
    const since = new Date(now.getTime() - DAY_MS);
    const sinceIso = since.toISOString();

    const hypeUsd = await this.readHypeUsd();
    // Sequential on purpose: three connections of a shared pool for one refresh would be two too many.
    const activeRows = await this.timed<ActiveSqlRow>(
      SNAPSHOT_TIMEOUT_MS,
      Prisma.sql`
        WITH day AS (
          -- V4 swaps only see the router: the trader is the tx sender.
          SELECT tr.token, sum(tr.quote_amount)::text AS vol24, count(*)::int AS txns24,
                 count(DISTINCT coalesce(tr.trader, t.from_addr))::int AS traders24
          FROM elysium_launch_trade tr
          LEFT JOIN elysium_tx t ON t.tx_hash = tr.tx_hash AND tr.trader IS NULL
          WHERE tr.block_time >= ${sinceIso}::timestamptz
          GROUP BY tr.token
        )
        SELECT ${LAUNCH_COLUMNS}, last.price AS price, before.price AS price_24h, day.vol24, day.txns24, day.traders24
        FROM day
        JOIN elysium_launch l ON l.token = day.token
        ${LAUNCH_JOINS}
        LEFT JOIN LATERAL (
          SELECT x.price FROM elysium_launch_trade x WHERE x.token = l.token
          ORDER BY x.block_time DESC, x.block_number DESC, x.log_index DESC LIMIT 1
        ) last ON true
        LEFT JOIN LATERAL (
          SELECT x.price FROM elysium_launch_trade x
          WHERE x.token = l.token AND x.block_time < ${sinceIso}::timestamptz
          ORDER BY x.block_time DESC, x.block_number DESC, x.log_index DESC LIMIT 1
        ) before ON true`
    );
    const padRows = await this.timed<{ launchpad: string; tokens: number; graduated: number; launched24h: number }>(
      SNAPSHOT_TIMEOUT_MS,
      Prisma.sql`
        SELECT launchpad, count(*)::int AS tokens,
               count(*) FILTER (WHERE graduated_at IS NOT NULL)::int AS graduated,
               count(*) FILTER (WHERE created_at >= ${sinceIso}::timestamptz)::int AS launched24h
        FROM elysium_launch GROUP BY launchpad`
    );

    const views = activeRows.map((r) => toLaunchTokenView(r, hypeUsd, r));
    const active = new Map(views.map((v) => [v.address, v]));
    const hot = [...views].sort(launchTokenSorter('hot'));
    const gainers = [...views].sort(launchTokenSorter('gainers'));

    const perPad = new Map(padRows.map((r) => [r.launchpad, r]));
    const pads = padRows.map((r) => ({ launchpad: r.launchpad, tokens: r.tokens })).sort((a, b) => b.tokens - a.tokens || (a.launchpad < b.launchpad ? -1 : 1));
    const summary: ElysiumLaunchpadSummary = {
      tokens: padRows.reduce((s, r) => s + r.tokens, 0),
      launched24h: padRows.reduce((s, r) => s + r.launched24h, 0),
      volume24h: views.reduce((s, v) => s + (v.volume24h ?? 0), 0),
      trades24h: views.reduce((s, v) => s + v.txns24h, 0),
      graduated: padRows.reduce((s, r) => s + r.graduated, 0),
      pads,
    };

    const partial: Snapshot = {
      at: now.getTime(),
      since,
      hypeUsd,
      active,
      hot,
      gainers,
      perPad,
      summary,
      top: { hot: [], gainers: [], fresh: [] },
    };
    const freshRows = await this.newest(partial, undefined, undefined, TOP_N);
    partial.top = {
      hot: hot.filter((v) => (v.volume24h ?? 0) > 0).slice(0, TOP_N),
      gainers: gainers.filter((v) => (v.volume24h ?? 0) >= GAINER_MIN_VOLUME).slice(0, TOP_N),
      fresh: freshRows,
    };
    return partial;
  }

  // ---------------------------------------------------------------------------
  // Reading launches out of elysium_launch
  // ---------------------------------------------------------------------------

  /** The views of `tokens`, in that order: the snapshot's for an active token, the launch row's for the others. */
  private async hydrate(snap: Snapshot, tokens: string[]): Promise<ElysiumLaunchTokenView[]> {
    const missing = tokens.filter((t) => !snap.active.has(t));
    const rows = missing.length
      ? await this.timed<LaunchSqlRow>(
          PAGE_TIMEOUT_MS,
          Prisma.sql`
            SELECT ${LAUNCH_COLUMNS}, l.last_price AS price
            FROM elysium_launch l ${LAUNCH_JOINS}
            WHERE l.token = ANY(${missing}::text[])`
        )
      : [];
    const byToken = new Map(rows.map((r) => [r.token, toLaunchTokenView(r, snap.hypeUsd)]));
    const out: ElysiumLaunchTokenView[] = [];
    for (const t of tokens) {
      const view = snap.active.get(t) ?? byToken.get(t);
      if (view) out.push(view);
    }
    return out;
  }

  /** `AND l.launchpad = …` when a launchpad is asked for. */
  private padFilter(pad: string | undefined): Prisma.Sql {
    return pad ? Prisma.sql`AND l.launchpad = ${pad}` : Prisma.empty;
  }

  /**
   * The newest launches first, `limit` of them. `where` narrows them; `inactiveOnly`
   * leaves out the tokens traded since the snapshot's 24h mark, which the caller
   * has already placed from the snapshot.
   */
  private async newestTokens(
    snap: Snapshot,
    pad: string | undefined,
    where: Prisma.Sql | undefined,
    limit: number,
    inactiveOnly = false
  ): Promise<string[]> {
    if (limit <= 0) return [];
    const rows = await this.timed<{ token: string }>(
      PAGE_TIMEOUT_MS,
      Prisma.sql`
        SELECT l.token FROM elysium_launch l
        WHERE true ${this.padFilter(pad)} ${where ?? Prisma.empty}
          ${
            inactiveOnly
              ? Prisma.sql`AND NOT EXISTS (
                  SELECT 1 FROM elysium_launch_trade tr
                  WHERE tr.token = l.token AND tr.block_time >= ${snap.since.toISOString()}::timestamptz)`
              : Prisma.empty
          }
        ORDER BY l.created_at DESC, l.token
        LIMIT ${limit}`
    );
    return rows.map((r) => r.token);
  }

  private async newest(snap: Snapshot, pad: string | undefined, where: Prisma.Sql | undefined, limit: number): Promise<ElysiumLaunchTokenView[]> {
    return this.hydrate(snap, await this.newestTokens(snap, pad, where, limit));
  }

  /** A token with a last price that is not zero: its 24h change is known (flat when it did not trade). */
  private static readonly PRICED = Prisma.sql`AND l.last_price IS NOT NULL AND l.last_price <> 0`;
  private static readonly UNPRICED = Prisma.sql`AND (l.last_price IS NULL OR l.last_price = 0)`;

  // ---------------------------------------------------------------------------
  // The four orders, without a search
  // ---------------------------------------------------------------------------

  /**
   * Hot: by 24h volume, then trades. Only the active tokens have either, so
   * they come first, in the snapshot's order; the others follow, newest first.
   */
  private async hotPage(snap: Snapshot, pad: string | undefined, limit: number): Promise<ElysiumLaunchTokenView[]> {
    const head = snap.hot.filter((v) => !pad || v.launchpad === pad).slice(0, limit);
    if (head.length >= limit) return head;
    const rest = await this.hydrate(snap, await this.newestTokens(snap, pad, undefined, limit - head.length, true));
    return head.concat(rest);
  }

  /**
   * Gainers: by 24h change, largest first, unknown last. A token that did not
   * trade is flat (0%) when it has a price, unknown when it never traded. So:
   * the active gainers, everything flat (active then the others), the active
   * losers, then everything unknown.
   */
  private async gainersPage(snap: Snapshot, pad: string | undefined, limit: number): Promise<ElysiumLaunchTokenView[]> {
    const active = snap.gainers.filter((v) => !pad || v.launchpad === pad);
    const up = active.filter((v) => v.change24h !== null && v.change24h > 0);
    const flat = active.filter((v) => v.change24h === 0);
    const down = active.filter((v) => v.change24h !== null && v.change24h < 0);
    const unknown = active.filter((v) => v.change24h === null);

    let out = up.concat(flat).slice(0, limit);
    if (out.length < limit) {
      out = out.concat(await this.hydrate(snap, await this.newestTokens(snap, pad, ElysiumLaunchpadMarketService.PRICED, limit - out.length, true)));
    }
    if (out.length < limit) out = out.concat(down.concat(unknown).slice(0, limit - out.length));
    if (out.length < limit) {
      out = out.concat(await this.hydrate(snap, await this.newestTokens(snap, pad, ElysiumLaunchpadMarketService.UNPRICED, limit - out.length, true)));
    }
    return out;
  }

  /**
   * Market cap: last price x supply, in USD. Within one quote token that is the
   * price order, which the (quote, last_price) index gives; the head of each
   * quote is read and merged at its USD value. Tokens without a USD value
   * (never traded, or a quote that has none) follow, newest first.
   */
  private async mcapPage(snap: Snapshot, pad: string | undefined, limit: number): Promise<ElysiumLaunchTokenView[]> {
    const valued = [...USD_QUOTES, ...(snap.hypeUsd !== null ? HYPE_QUOTES : [])];
    const heads = valued.map(
      (quote) => Prisma.sql`
        (SELECT l.token, l.last_price, l.quote, (extract(epoch FROM l.created_at))::float8 AS born
         FROM elysium_launch l
         WHERE l.quote = ${quote} AND l.last_price > 0 ${this.padFilter(pad)}
         ORDER BY l.last_price DESC, l.created_at DESC, l.token LIMIT ${limit})`
    );
    const rows = await this.timed<{ token: string; last_price: number; quote: string; born: number }>(
      PAGE_TIMEOUT_MS,
      Prisma.sql`${Prisma.join(heads, ' UNION ALL ')}`
    );
    const ranked = rows
      // Same tie order as each head (newest, then address), so a shorter page is the head of a longer one.
      .map((r) => ({ token: r.token, usd: r.last_price * (quoteUsd(r.quote, snap.hypeUsd) ?? 0), born: r.born }))
      .sort((a, b) => b.usd - a.usd || b.born - a.born || (a.token < b.token ? -1 : 1))
      .slice(0, limit);
    let out = await this.hydrate(snap, ranked.map((r) => r.token));
    if (out.length < limit) {
      // Everything without a USD value: no positive price, or a quote that is not valued.
      // (Spelled out: `NOT (quote = ANY(…) AND last_price > 0)` is NULL, not true, for a NULL price.)
      const unvalued = Prisma.sql`AND (l.last_price IS NULL OR l.last_price <= 0 OR NOT (l.quote = ANY(${valued}::text[])))`;
      out = out.concat(await this.newest(snap, pad, unvalued, limit - out.length));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /** Runs `fn` when one of the search slots is free; refuses when too many already wait. */
  private async withSearchSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.searching >= SEARCH_CONCURRENCY) {
      if (this.searchWaiters.length >= SEARCH_MAX_WAITING) throw new LaunchpadSearchBusyError();
      await new Promise<void>((resolve) => this.searchWaiters.push(resolve));
    } else {
      this.searching += 1;
    }
    try {
      return await fn();
    } finally {
      // Hand the slot to the next waiter, or free it.
      const next = this.searchWaiters.shift();
      if (next) next();
      else this.searching -= 1;
    }
  }

  /**
   * A search reads its matches (symbol, name or address containing `q`), newest
   * first up to SEARCH_MAX_MATCHES, and sorts them here in the requested order:
   * the active ones carry their 24h figures from the snapshot, the others are
   * flat with no volume.
   */
  private async searchPage(
    snap: Snapshot,
    query: ElysiumLaunchpadQuery & { q: string }
  ): Promise<{ tokens: ElysiumLaunchTokenView[]; total: number; totalCapped: boolean }> {
    const pattern = containsPattern(query.q);
    const rows = await this.withSearchSlot(() =>
      this.timed<{ token: string; last_price: number | null; quote: string; born: number; launchpad: string }>(
        PAGE_TIMEOUT_MS,
        Prisma.sql`
          SELECT l.token, l.last_price, l.quote, l.launchpad, (extract(epoch FROM l.created_at))::float8 AS born
          FROM elysium_launch l
          WHERE (l.symbol ILIKE ${pattern} OR l.name ILIKE ${pattern} OR l.token ILIKE ${pattern}) ${this.padFilter(query.pad)}
          ORDER BY l.created_at DESC, l.token
          LIMIT ${SEARCH_MAX_MATCHES + 1}`
      )
    );
    const totalCapped = rows.length > SEARCH_MAX_MATCHES;
    const matches = totalCapped ? rows.slice(0, SEARCH_MAX_MATCHES) : rows;
    // Enough of a view to sort on; the rows of the page are then read in full.
    const keys = matches.map((r): ElysiumLaunchTokenView => {
      const active = snap.active.get(r.token);
      if (active) return active;
      const usd = quoteUsd(r.quote, snap.hypeUsd);
      const priceUsd = r.last_price !== null && usd !== null ? r.last_price * usd : null;
      return {
        address: r.token,
        symbol: '',
        name: '',
        launchpad: r.launchpad,
        creator: null,
        priceUsd,
        change24h: r.last_price ? 0 : null,
        volume24h: usd !== null ? 0 : null,
        txns24h: 0,
        traders24h: 0,
        holders: null,
        marketCap: priceUsd !== null ? priceUsd * LAUNCH_TOTAL_SUPPLY : null,
        top10Pct: null,
        devPct: null,
        curvePct: null,
        bornAt: Math.round(r.born),
        graduated: false,
      };
    });
    const page = keys.sort(launchTokenSorter(query.sort)).slice(0, query.limit);
    return {
      tokens: await this.hydrate(snap, page.map((v) => v.address)),
      total: matches.length,
      totalCapped,
    };
  }

  // ---------------------------------------------------------------------------
  // Public read
  // ---------------------------------------------------------------------------

  /**
   * The first `limit` tokens of an order, with the totals and the mini lists.
   * Pages are kept for the snapshot they were built from, and a page being
   * computed is shared by everyone asking for it.
   */
  public async getPage(query: ElysiumLaunchpadQuery): Promise<ElysiumLaunchpadPage> {
    const snap = await this.getSnapshot();
    const q = query.q?.trim().toLowerCase() || undefined;
    const key = `${snap.at}|${query.pad ?? ''}|${query.sort}|${query.limit}|${q ?? ''}`;
    let pending = this.pages.get(key);
    if (!pending) {
      pending = this.computePage(snap, { ...query, q });
      // A failed page is not kept: the next request computes it again.
      pending.catch(() => {
        if (this.pages.get(key) === pending) this.pages.delete(key);
      });
      if (this.pages.size >= PAGE_CACHE_MAX) {
        const oldest = this.pages.keys().next().value;
        if (oldest !== undefined) this.pages.delete(oldest);
      }
      this.pages.set(key, pending);
    }
    const page = await pending;
    return { ...page, summary: snap.summary, top: snap.top, hypeUsd: snap.hypeUsd, computedAt: new Date(snap.at).toISOString() };
  }

  private async computePage(
    snap: Snapshot,
    query: ElysiumLaunchpadQuery
  ): Promise<{ tokens: ElysiumLaunchTokenView[]; total: number; totalCapped: boolean }> {
    if (query.q) return this.searchPage(snap, { ...query, q: query.q });
    const { pad, sort, limit } = query;
    let tokens: ElysiumLaunchTokenView[];
    if (sort === 'new') tokens = await this.newest(snap, pad, undefined, limit);
    else if (sort === 'gainers') tokens = await this.gainersPage(snap, pad, limit);
    else if (sort === 'mcap') tokens = await this.mcapPage(snap, pad, limit);
    else tokens = await this.hotPage(snap, pad, limit);
    const total = pad ? (snap.perPad.get(pad)?.tokens ?? 0) : snap.summary.tokens;
    return { tokens, total, totalCapped: false };
  }
}
