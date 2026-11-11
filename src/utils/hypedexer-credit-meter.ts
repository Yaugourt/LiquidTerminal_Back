import type { redisService as RedisService } from '../core/redis.service';
import { logDeduplicator } from './logDeduplicator';

/**
 * What HypeDexer bills us, from the `X-Credit-Cost` header it puts on every
 * successful response (errors are free; no other upstream sends the header).
 *
 * - Per process: calls and credits per upstream path, logged once a minute,
 *   so a route that starts burning shows up in the logs by name.
 * - Across instances: the day's total in Redis (`hypedexer:credits:YYYY-MM-DD`,
 *   UTC), with one warning per process and day once it passes the budget
 *   (`HYPEDEXER_DAILY_CREDIT_BUDGET`, default 1 000 000); since 2026-11-11
 *   also the day's credits and calls per path (`hypedexer:credits:paths:…`,
 *   `hypedexer:credits:calls:…`, added once a minute) and the last balance the
 *   provider gave. `summary()` reads them back: until then the totals existed
 *   and nothing showed them.
 *
 * A warning only: nothing here ever delays or refuses a call.
 */

const FLUSH_INTERVAL_MS = 60_000;
const TOP_PATHS_LOGGED = 10;
const DAY_KEY_TTL_SECONDS = 8 * 24 * 60 * 60;
/**
 * Above the background alone (~320k a day with zero visitors) plus a busy day
 * of live tiles, so the warning means something. The Elysium ingestion
 * (~2.3M a day when enabled) exceeds it on purpose: it is under investigation.
 */
const DEFAULT_DAILY_BUDGET = 1_000_000;

/**
 * Loaded on first use: importing the Redis service opens its connections, and
 * this module sits under BaseApiService, which scripts and tests import
 * without wanting Redis.
 */
async function redis(): Promise<typeof RedisService> {
  const { redisService } = await import('../core/redis.service');
  return redisService;
}

function dailyBudget(): number {
  const raw = Number(process.env.HYPEDEXER_DAILY_CREDIT_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
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

export interface CreditSummary {
  /** The last UTC days, today first; null for a day Redis holds no total of. */
  days: Array<{ day: string; credits: number | null }>;
  topPathsToday: Array<{ path: string; credits: number; calls: number }>;
  balance: number | null;
}

const PATHS_KEY = 'hypedexer:credits:paths:';
const CALLS_KEY = 'hypedexer:credits:calls:';
const BALANCE_KEY = 'hypedexer:credits:balance';

export class HypedexerCreditMeter {
  private perPath = new Map<string, PathSpend>();
  private timer: NodeJS.Timeout | null = null;
  private warnedDay: string | null = null;
  private lastBalance: number | null = null;

  /** Record one successful upstream response. Ignores responses without a cost header. */
  record(url: string, costHeader: string | null, balanceHeader?: string | null): void {
    if (costHeader === null || costHeader === '') return;
    const cost = Number(costHeader);
    if (!Number.isFinite(cost) || cost < 0) return;

    const path = creditPath(url);
    const spend = this.perPath.get(path) ?? { calls: 0, credits: 0 };
    spend.calls += 1;
    spend.credits += cost;
    this.perPath.set(path, spend);

    const balance = Number(balanceHeader);
    if (balanceHeader && Number.isFinite(balance)) this.lastBalance = balance;

    this.ensureTimer();
    void this.addToDay(cost);
  }

  private async addToDay(cost: number): Promise<void> {
    const day = utcDay();
    const key = `hypedexer:credits:${day}`;
    try {
      const client = (await redis()).getClient();
      const total = await client.incrby(key, Math.round(cost));
      if (total === Math.round(cost)) await client.expire(key, DAY_KEY_TTL_SECONDS);
      const budget = dailyBudget();
      if (total > budget && this.warnedDay !== day) {
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

  /** Adds the last minute's spend per path to the day's (one round trip), and keeps the balance. */
  private async addPathsToDay(entries: Array<[string, PathSpend]>): Promise<void> {
    const day = utcDay();
    try {
      const pipeline = (await redis()).getClient().pipeline();
      for (const [path, spend] of entries) {
        pipeline.hincrby(`${PATHS_KEY}${day}`, path, Math.round(spend.credits));
        pipeline.hincrby(`${CALLS_KEY}${day}`, path, spend.calls);
      }
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
      const [totals, paths, calls, balance] = await Promise.all([
        client.mget(keys.map((d) => `hypedexer:credits:${d}`)),
        client.hgetall(`${PATHS_KEY}${keys[0]}`),
        client.hgetall(`${CALLS_KEY}${keys[0]}`),
        client.get(BALANCE_KEY),
      ]);
      return {
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
  }
}

export const hypedexerCreditMeter = new HypedexerCreditMeter();
