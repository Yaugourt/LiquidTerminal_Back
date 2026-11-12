import type { redisService as RedisService } from '../core/redis.service';
import { logDeduplicator } from './logDeduplicator';

/**
 * What HypeDexer bills us, from the `X-Credit-Cost` header it puts on every
 * successful response (errors are free; no other upstream sends the header).
 *
 * - Per process: calls and credits per upstream path, logged once a minute,
 *   so a route that starts burning shows up in the logs by name.
 * - Across instances: the day's total in Redis (`hypedexer:credits:YYYY-MM-DD`,
 *   UTC); since 2026-11-11 also the day's credits and calls per path
 *   (`hypedexer:credits:paths:…`, `hypedexer:credits:calls:…`, added once a
 *   minute) and the last balance the provider gave; since 2026-11-12 the
 *   credits of each hour (`hypedexer:credits:hours:YYYY-MM-DD`, added once a
 *   minute). `summary()` reads them back.
 *
 * What is too much is judged against the days and the hours before, by whoever
 * reads `summary()` (the Elysium alerts): the key's balance stood at 999.45
 * billion credits on 2026-11-12, so no fixed figure says anything about it.
 * The fixed warning that was here (1,000,000 a day by default) was passed on
 * most days and told nobody anything. It is still there for whoever sets a
 * figure (`HYPEDEXER_DAILY_CREDIT_BUDGET`): one warning per process and day
 * once the day passes it; without the variable, none.
 *
 * A warning only: nothing here ever delays or refuses a call.
 */

const FLUSH_INTERVAL_MS = 60_000;
const TOP_PATHS_LOGGED = 10;
const DAY_KEY_TTL_SECONDS = 8 * 24 * 60 * 60;
/** How many completed hours `summary()` lists, newest first. */
const HOURS_LISTED = 24;
/** The hours the highest one is looked for in: the seven days before the current hour. */
const HOURS_COMPARED = 7 * 24;

/**
 * Loaded on first use: importing the Redis service opens its connections, and
 * this module sits under BaseApiService, which scripts and tests import
 * without wanting Redis.
 */
async function redis(): Promise<typeof RedisService> {
  const { redisService } = await import('../core/redis.service');
  return redisService;
}

/** The day's figure past which a warning is logged, when one was set; null otherwise. */
function dailyBudget(): number | null {
  const raw = Number(process.env.HYPEDEXER_DAILY_CREDIT_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The UTC hour of a time, as `YYYY-MM-DDTHH`. */
function utcHour(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

/**
 * The upstream path as a low-cardinality log key: no host, no query string,
 * addresses / hashes / numeric ids replaced by placeholders.
 */
export function creditPath(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0];
  }
  return path
    .replace(/0x[0-9a-fA-F]{64}/g, ':hash')
    .replace(/0x[0-9a-fA-F]{40}/g, ':address')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/+$/, '') || '/';
}

interface PathSpend {
  calls: number;
  credits: number;
}

/**
 * Distinct paths one process names in a day; the calls to any further one are counted together
 * under OTHER_PATHS. creditPath folds addresses, hashes and numeric ids, not every identifier a
 * path can carry (a ticker, a composite trade id): without a ceiling, each new one would add a
 * field to the day's hashes in Redis, which the status reads whole every 15 seconds.
 */
const MAX_PATHS_A_DAY = 200;
const OTHER_PATHS = '(other paths)';

export interface CreditHour {
  /** `YYYY-MM-DDTHH`, UTC. */
  hour: string;
  credits: number;
}

export interface CreditSummary {
  /** The last UTC days, today first; null for a day Redis holds no total of. */
  days: Array<{ day: string; credits: number | null }>;
  topPathsToday: Array<{ path: string; credits: number; calls: number }>;
  balance: number | null;
  /**
   * By the hour: the one that is running, the last completed ones (newest first), and the
   * highest of the completed hours of the seven days before, with how many of those are known
   * (an hour nothing was recorded for is not one).
   */
  hours: { current: CreditHour; last: CreditHour[]; highest: CreditHour | null; known: number };
}

const PATHS_KEY = 'hypedexer:credits:paths:';
const CALLS_KEY = 'hypedexer:credits:calls:';
const HOURS_KEY = 'hypedexer:credits:hours:';
const BALANCE_KEY = 'hypedexer:credits:balance';

export class HypedexerCreditMeter {
  private perPath = new Map<string, PathSpend>();
  private timer: NodeJS.Timeout | null = null;
  private warnedDay: string | null = null;
  private lastBalance: number | null = null;
  /** The paths named so far on `namedDay`. */
  private readonly named = new Set<string>();
  private namedDay = '';

  /** Record one successful upstream response. Ignores responses without a cost header. */
  record(url: string, costHeader: string | null, balanceHeader?: string | null): void {
    if (costHeader === null || costHeader === '') return;
    const cost = Number(costHeader);
    if (!Number.isFinite(cost) || cost < 0) return;

    const path = this.bounded(creditPath(url));
    const spend = this.perPath.get(path) ?? { calls: 0, credits: 0 };
    spend.calls += 1;
    spend.credits += cost;
    this.perPath.set(path, spend);

    const balance = Number(balanceHeader);
    if (balanceHeader && Number.isFinite(balance)) this.lastBalance = balance;

    this.ensureTimer();
    void this.addToDay(cost);
  }

  /** `path`, or OTHER_PATHS once this process has named MAX_PATHS_A_DAY of them today. */
  private bounded(path: string): string {
    const day = utcDay();
    if (day !== this.namedDay) {
      this.namedDay = day;
      this.named.clear();
    }
    if (this.named.has(path)) return path;
    if (this.named.size >= MAX_PATHS_A_DAY) return OTHER_PATHS;
    this.named.add(path);
    return path;
  }

  private async addToDay(cost: number): Promise<void> {
    const day = utcDay();
    const key = `hypedexer:credits:${day}`;
    try {
      const client = (await redis()).getClient();
      const total = await client.incrby(key, Math.round(cost));
      if (total === Math.round(cost)) await client.expire(key, DAY_KEY_TTL_SECONDS);
      const budget = dailyBudget();
      if (budget !== null && total > budget && this.warnedDay !== day) {
        this.warnedDay = day;
        logDeduplicator.warn('HypeDexer daily credit budget exceeded', {
          day,
          credits: total,
          budget,
          balance: this.lastBalance,
        });
      }
    } catch (error) {
      logDeduplicator.warn('HypeDexer credit meter: could not update the daily total', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Log the last minute's spend per path and reset it. */
  flush(): void {
    if (this.perPath.size === 0) return;
    const entries = [...this.perPath.entries()].sort((a, b) => b[1].credits - a[1].credits);
    this.perPath = new Map();
    let calls = 0;
    let credits = 0;
    for (const [, s] of entries) {
      calls += s.calls;
      credits += s.credits;
    }
    void this.addPathsToDay(entries);
    logDeduplicator.info('HypeDexer credits (last minute)', {
      calls,
      credits,
      balance: this.lastBalance,
      topPaths: entries
        .slice(0, TOP_PATHS_LOGGED)
        .map(([path, s]) => `${path} ${s.credits}cr/${s.calls}`),
    });
  }

  /**
   * Adds the last minute's spend per path to the day's, and its total to the hour's (one round
   * trip), and keeps the balance.
   */
  private async addPathsToDay(entries: Array<[string, PathSpend]>): Promise<void> {
    const now = Date.now();
    const day = utcDay(now);
    try {
      const pipeline = (await redis()).getClient().pipeline();
      let credits = 0;
      for (const [path, spend] of entries) {
        pipeline.hincrby(`${PATHS_KEY}${day}`, path, Math.round(spend.credits));
        pipeline.hincrby(`${CALLS_KEY}${day}`, path, spend.calls);
        credits += spend.credits;
      }
      pipeline.hincrby(`${HOURS_KEY}${day}`, utcHour(now).slice(11), Math.round(credits));
      pipeline.expire(`${HOURS_KEY}${day}`, DAY_KEY_TTL_SECONDS);
      pipeline.expire(`${PATHS_KEY}${day}`, DAY_KEY_TTL_SECONDS);
      pipeline.expire(`${CALLS_KEY}${day}`, DAY_KEY_TTL_SECONDS);
      if (this.lastBalance !== null) pipeline.set(BALANCE_KEY, String(this.lastBalance), 'EX', DAY_KEY_TTL_SECONDS);
      await pipeline.exec();
    } catch (error) {
      logDeduplicator.warn('HypeDexer credit meter: could not update the per-path totals', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * What was spent, across instances: the totals of the last `days` UTC days (today first), the
   * paths that cost the most today, and the balance the provider last gave. Null when Redis
   * cannot say.
   */
  async summary(days = 8, topPaths = 12): Promise<CreditSummary | null> {
    try {
      const client = (await redis()).getClient();
      const now = Date.now();
      const keys = Array.from({ length: days }, (_, i) => utcDay(now - i * 86_400_000));
      const [totals, paths, calls, balance, ...hourly] = await Promise.all([
        client.mget(keys.map((d) => `hypedexer:credits:${d}`)),
        client.hgetall(`${PATHS_KEY}${keys[0]}`),
        client.hgetall(`${CALLS_KEY}${keys[0]}`),
        client.get(BALANCE_KEY),
        ...keys.map((d) => client.hgetall(`${HOURS_KEY}${d}`)),
      ]);
      // Every hour something was recorded for, newest first.
      const hours: CreditHour[] = [];
      keys.forEach((day, i) => {
        for (const [hh, credits] of Object.entries((hourly[i] as Record<string, string> | null) ?? {})) {
          if (/^\d{2}$/.test(hh) && Number.isFinite(Number(credits))) hours.push({ hour: `${day}T${hh}`, credits: Number(credits) });
        }
      });
      hours.sort((a, b) => (a.hour < b.hour ? 1 : -1));
      const currentHour = utcHour(now);
      const firstCompared = utcHour(now - HOURS_COMPARED * 3_600_000);
      const completed = hours.filter((h) => h.hour < currentHour);
      const compared = completed.filter((h) => h.hour >= firstCompared);
      return {
        hours: {
          current: hours.find((h) => h.hour === currentHour) ?? { hour: currentHour, credits: 0 },
          last: completed.slice(0, HOURS_LISTED),
          highest: compared.reduce<CreditHour | null>((top, h) => (top === null || h.credits > top.credits ? h : top), null),
          known: compared.length,
        },
        days: keys.map((day, i) => ({ day, credits: totals[i] === null ? null : Number(totals[i]) })),
        topPathsToday: Object.entries(paths ?? {})
          .map(([path, credits]) => ({ path, credits: Number(credits), calls: Number(calls?.[path] ?? 0) }))
          .sort((a, b) => b.credits - a.credits)
          .slice(0, topPaths),
        balance: balance === null ? null : Number(balance),
      };
    } catch {
      return null;
    }
  }

  /** The day's total across instances (UTC), or null when Redis can't say. */
  async todayTotal(): Promise<number | null> {
    try {
      const value = await (await redis()).get(`hypedexer:credits:${utcDay()}`);
      return value === null ? 0 : Number(value);
    } catch {
      return null;
    }
  }

  /** Test helper: stop the timer and forget everything. */
  reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.perPath = new Map();
    this.warnedDay = null;
    this.lastBalance = null;
    this.named.clear();
    this.namedDay = '';
  }
}

export const hypedexerCreditMeter = new HypedexerCreditMeter();
