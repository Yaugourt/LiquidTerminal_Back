import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';
import { RecentEventCache } from '../../utils/telegram.alert-dedup';

/**
 * Generic alert engine shared by every Telegram alert type.
 *
 * One pipeline = one alert type (fills, liquidations, closed trades, ...). It
 * supplies its rules, how to read an event, and how to deliver a match; the
 * engine does the rest, identically for every type:
 *
 * - Rules are loaded on a background timer and compiled into an index by
 *   wallet and by coin, so an event only meets the rules that can match it
 *   (O(candidates), not O(all subscriptions)). The hot path never waits on
 *   the database.
 * - Dedup claims the (scope, event) keys in one Redis pipeline (SET NX EX), with
 *   an in-memory cache in front. If Redis is down it falls back to memory and
 *   fails open, as before. No database write per alert any more.
 * - A per-user budget (50 individual alerts/min, under the bot's 60/min
 *   per-chat rate) stops one noisy rule from building an ever-growing backlog
 *   in the bot; past it, alerts are grouped into digests, so they still
 *   arrive on time.
 * - Events go through a serial queue that drains in large passes (one Redis
 *   round trip per pass); its cap is a memory guard, counted if ever hit.
 * - Counters per pipeline are logged every 5 minutes.
 *
 * Adding an alert type means writing a pipeline, not another dispatcher.
 */

/** A compiled subscription. `wallets`/`coins` empty = no constraint on that axis. */
export interface AlertRule<E> {
  id: string;
  /** Telegram chat to deliver to (BigInt as string). */
  telegramId: string;
  /** Lowercase addresses the event must involve. Empty = any wallet. */
  wallets: string[];
  /** Uppercase coins the event must be on. Empty = any coin. */
  coins: string[];
  /** Remaining filters (size, side, direction, ...), run on candidates only. */
  matches: (event: E) => boolean;
  /** Dedup scope: one alert per (scope, event). A rule id, or a user id for per-user dedup. */
  dedupScope: string;
}

export interface EventKeys {
  /** Stable event id (hash, trade id, order id...). */
  id: string;
  /** Lowercase addresses involved in the event. */
  wallets: string[];
  coin: string;
}

export interface AlertPipeline<E, R extends AlertRule<E> = AlertRule<E>> {
  /** Short name, used in dedup keys, logs and counters. */
  name: string;
  loadRules: () => Promise<R[]>;
  keys: (event: E) => EventKeys;
  deliver: (rule: R, event: E) => void;
  /**
   * Optional: runs once per batch before delivery with the events about to
   * go out (to look up data the messages need). Errors are ignored.
   */
  prepare?: (events: E[]) => Promise<void>;
  /** One short HTML line for an alert sent inside a digest (over-budget users). */
  summarize: (rule: R, event: E) => string;
  /** Sends a plain HTML message to a user (used for digests). */
  notify: (telegramId: string, message: string) => void;
}

export interface AlertEngineOptions {
  /** How often rules are reloaded. */
  refreshMs?: number;
  /** Per-user budget. Defaults to the process-wide shared limiter. */
  limiter?: DeliveryLimiter;
  /** Events waiting before the oldest are dropped (memory guard, never hit in normal load). */
  maxPendingEvents?: number;
  /** Dedup key lifetime. */
  dedupTtlSeconds?: number;
}

/** Index of rules by wallet and by coin. Built once per refresh, read on every event. */
export class RuleIndex<E, R extends AlertRule<E> = AlertRule<E>> {
  private readonly byWallet = new Map<string, R[]>();
  private readonly byCoin = new Map<string, R[]>();
  private readonly wildcard: R[] = [];
  readonly size: number;

  constructor(rules: R[]) {
    this.size = rules.length;
    for (const rule of rules) {
      if (rule.wallets.length > 0) {
        for (const w of new Set(rule.wallets)) push(this.byWallet, w, rule);
      } else if (rule.coins.length > 0) {
        for (const c of new Set(rule.coins)) push(this.byCoin, c, rule);
      } else {
        this.wildcard.push(rule);
      }
    }
  }

  /**
   * Rules whose wallet and coin constraints the event satisfies. Wallet rules
   * are reached through the wallet map and then checked on coin; coin-only
   * rules through the coin map; unconstrained rules always.
   */
  candidates(keys: EventKeys): R[] {
    const coin = keys.coin.toUpperCase();
    const out: R[] = [];
    const seen = new Set<string>();
    for (const w of keys.wallets) {
      for (const rule of this.byWallet.get(w) ?? []) {
        if (seen.has(rule.id)) continue;
        if (rule.coins.length > 0 && !rule.coins.includes(coin)) continue;
        seen.add(rule.id);
        out.push(rule);
      }
    }
    for (const rule of this.byCoin.get(coin) ?? []) out.push(rule);
    for (const rule of this.wildcard) out.push(rule);
    return out;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Fixed-window per-user budget. */
export class DeliveryLimiter {
  private readonly windows = new Map<string, { start: number; sent: number }>();

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** True if the user may receive one more individual alert now. */
  allow(user: string): boolean {
    const t = this.now();
    let w = this.windows.get(user);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, sent: 0 };
      this.windows.set(user, w);
      if (this.windows.size > 50_000) this.prune(t);
    }
    if (w.sent < this.limit) {
      w.sent += 1;
      return true;
    }
    return false;
  }

  private prune(t: number): void {
    for (const [user, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(user);
  }
}

/**
 * Serial event queue. Producers push events (any batch size); the worker takes
 * everything waiting, up to `chunk` events, in one call, so a burst is handled
 * in a few large passes instead of thousands of small ones. The cap counts
 * events and is a memory guard only: past it the oldest events are dropped
 * and counted, which should never happen in normal operation.
 */
export class BoundedSerialQueue<T> {
  private pending: T[] = [];
  private running = false;
  dropped = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly worker: (items: T[]) => Promise<void>,
    private readonly context: string,
    private readonly chunk: number = 5_000
  ) {}

  push(items: T[]): void {
    for (const item of items) this.pending.push(item);
    const over = this.pending.length - this.maxEvents;
    if (over > 0) {
      this.pending.splice(0, over);
      this.dropped += over;
    }
    if (!this.running) void this.drain();
  }

  get depth(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending.length) {
      const items = this.pending.length <= this.chunk ? this.pending : this.pending.slice(0, this.chunk);
      this.pending = this.pending.length <= this.chunk ? [] : this.pending.slice(this.chunk);
      try {
        await this.worker(items);
      } catch (error) {
        logDeduplicator.error(`${this.context}: batch failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.running = false;
  }
}

/**
 * One budget per Telegram user across every alert type. The bot sends at most
 * 1 message/s to a chat (Telegram's per-chat limit), 60/min. Individual alerts
 * get 50 of those; past it, alerts are grouped into digests (at most
 * DIGEST_MESSAGES_PER_FLUSH messages every DIGEST_FLUSH_MS, i.e. 8/min), so
 * an over-active user still sees every alert, on time, in fewer messages,
 * instead of a backlog that the old pipeline delivered later and later.
 */
export const DEFAULT_PER_USER_LIMIT = 50;
const DIGEST_FLUSH_MS = 15_000;
const DIGEST_MESSAGES_PER_FLUSH = 2;
const DIGEST_MAX_CHARS = 3_800; // Telegram caps a message at 4096
const DIGEST_MAX_LINES_HELD = 2_000; // memory guard per user
export const DEFAULT_PER_USER_WINDOW_MS = 60_000;
export const sharedDeliveryLimiter = new DeliveryLimiter(DEFAULT_PER_USER_LIMIT, DEFAULT_PER_USER_WINDOW_MS);

interface Counters {
  events: number;
  candidates: number;
  matched: number;
  duplicates: number;
  digested: number;
  digestOverflow: number;
  sent: number;
}

const zero = (): Counters => ({ events: 0, candidates: 0, matched: 0, duplicates: 0, digested: 0, digestOverflow: 0, sent: 0 });

export class AlertEngine<E, R extends AlertRule<E> = AlertRule<E>> {
  private index: RuleIndex<E, R> = new RuleIndex<E, R>([]);
  private readonly recent = new RecentEventCache();
  private readonly limiter: DeliveryLimiter;
  private readonly queue: BoundedSerialQueue<E>;
  private counters = zero();
  private timers: NodeJS.Timeout[] = [];
  private loaded = false;
  private refreshing: Promise<void> | null = null;
  /** True while Redis dedup is unavailable (logged once per outage). */
  private redisDown = false;
  /** Over-budget alerts waiting for the next digest, per Telegram user. */
  private readonly held = new Map<string, { lines: string[]; overflow: number }>();
  private readonly opts: Required<AlertEngineOptions>;

  constructor(private readonly pipeline: AlertPipeline<E, R>, options: AlertEngineOptions = {}) {
    this.opts = {
      refreshMs: 30_000,
      limiter: sharedDeliveryLimiter,
      maxPendingEvents: 100_000,
      dedupTtlSeconds: 24 * 60 * 60,
      ...options,
    };
    this.limiter = this.opts.limiter;
    this.queue = new BoundedSerialQueue<E>(this.opts.maxPendingEvents, (batch) => this.process(batch), `AlertEngine:${pipeline.name}`);
  }

  start(): void {
    void this.refresh();
    this.timers.push(setInterval(() => void this.refresh(), this.opts.refreshMs));
    this.timers.push(setInterval(() => this.flushDigests(), DIGEST_FLUSH_MS));
    this.timers.push(setInterval(() => this.logCounters(), 5 * 60_000));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    // Send what is still waiting for a digest instead of dropping it.
    this.flushDigests(Number.POSITIVE_INFINITY);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.index = new RuleIndex<E, R>([]);
    this.loaded = false;
    this.recent.clear();
    this.held.clear();
  }

  /** Queue a batch of events. Never blocks the caller. */
  ingest(events: E[]): void {
    if (events.length) this.queue.push(events);
  }

  /** Current number of compiled rules (for health checks and tests). */
  get ruleCount(): number {
    return this.index.size;
  }

  /** Reload and recompile the rules. Keeps the previous index on failure. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        this.index = new RuleIndex<E, R>(await this.pipeline.loadRules());
        this.loaded = true;
      } catch (error) {
        logDeduplicator.error(`AlertEngine:${this.pipeline.name}: rule refresh failed, keeping previous rules`, {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /**
   * Run one batch through matching, dedup, budget and delivery (exposed for
   * tests). Matching is synchronous; dedup is one Redis round trip for the
   * whole batch; delivery keeps the events' order.
   */
  async process(events: E[]): Promise<void> {
    if (!this.loaded) await this.refresh();
    const index = this.index;
    if (index.size === 0) return;

    const fresh: { rule: R; event: E; key: string; eventId: string }[] = [];
    for (const event of events) {
      this.counters.events += 1;
      const keys = this.pipeline.keys(event);
      const candidates = index.candidates(keys);
      if (!candidates.length) continue;
      this.counters.candidates += candidates.length;
      for (const rule of candidates) {
        if (!rule.matches(event)) continue;
        this.counters.matched += 1;
        // Memory first: repeats inside the stream never reach Redis.
        const key = `alert:${this.pipeline.name}:${rule.dedupScope}:${keys.id}`;
        if (this.recent.has(key)) {
          this.counters.duplicates += 1;
          continue;
        }
        this.recent.add(key);
        fresh.push({ rule, event, key, eventId: keys.id });
      }
    }
    if (!fresh.length) return;

    // One pipeline for the batch. null = Redis unavailable: memory dedup only, fail open.
    const claimed = await redisService.claimKeys(fresh.map((f) => f.key), this.opts.dedupTtlSeconds);
    if (!claimed && !this.redisDown) {
      this.redisDown = true;
      logDeduplicator.warn(`AlertEngine:${this.pipeline.name}: Redis dedup unavailable, delivering with in-memory dedup only`);
    } else if (claimed && this.redisDown) {
      this.redisDown = false;
      logDeduplicator.info(`AlertEngine:${this.pipeline.name}: Redis dedup back`);
    }

    if (this.pipeline.prepare) {
      const going = fresh.filter((_f, i) => !claimed || claimed[i]).map((f) => f.event);
      if (going.length) await this.pipeline.prepare(going).catch(() => undefined);
    }

    fresh.forEach(({ rule, event, eventId }, i) => {
      if (claimed && !claimed[i]) {
        this.counters.duplicates += 1;
        return;
      }
      if (!this.limiter.allow(rule.telegramId)) {
        this.hold(rule, event);
        return;
      }
      try {
        this.pipeline.deliver(rule, event);
        this.counters.sent += 1;
      } catch (error) {
        logDeduplicator.error(`AlertEngine:${this.pipeline.name}: delivery failed`, {
          ruleId: rule.id,
          eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private hold(rule: R, event: E): void {
    let h = this.held.get(rule.telegramId);
    if (!h) {
      h = { lines: [], overflow: 0 };
      this.held.set(rule.telegramId, h);
    }
    if (h.lines.length >= DIGEST_MAX_LINES_HELD) {
      h.overflow += 1;
      return;
    }
    try {
      h.lines.push(this.pipeline.summarize(rule, event));
      this.counters.digested += 1;
    } catch {
      h.overflow += 1;
    }
  }

  /**
   * Send each over-budget user their held alerts as digests: up to
   * DIGEST_MESSAGES_PER_FLUSH messages of whole lines. Lines that don't fit
   * wait for the next flush; only past DIGEST_MAX_LINES_HELD are they counted
   * instead of listed (and the count is always shown).
   */
  flushDigests(maxMessages: number = DIGEST_MESSAGES_PER_FLUSH): void {
    for (const [user, h] of this.held) {
      const messages: string[] = [];
      while (h.lines.length && messages.length < maxMessages) {
        const header = `📦 <b>More ${this.pipeline.name} alerts</b> <i>(grouped: over ${this.limiter.limit}/min)</i>\n`;
        let body = '';
        let taken = 0;
        while (taken < h.lines.length && header.length + body.length + h.lines[taken].length + 1 < DIGEST_MAX_CHARS) {
          body += h.lines[taken] + '\n';
          taken += 1;
        }
        if (taken === 0) taken = 1; // a single oversized line still moves on
        h.lines.splice(0, taken);
        messages.push(header + body);
      }
      if (!h.lines.length && h.overflow) {
        const last = messages.length ? messages.pop() as string : '';
        messages.push(`${last}… and ${h.overflow} more not listed. Raise the minimum size or narrow the coins to see every alert.`);
        this.counters.digestOverflow += h.overflow;
        h.overflow = 0;
      }
      for (const m of messages) {
        try {
          this.pipeline.notify(user, m);
        } catch {
          // Best effort.
        }
      }
      if (!h.lines.length && !h.overflow) this.held.delete(user);
    }
  }

  private logCounters(): void {
    const c = this.counters;
    this.counters = zero();
    if (!c.events && !this.queue.dropped) return;
    let heldLines = 0;
    for (const h of this.held.values()) heldLines += h.lines.length;
    logDeduplicator.info(`AlertEngine:${this.pipeline.name}: 5 min summary`, {
      rules: this.index.size,
      ...c,
      queueDepth: this.queue.depth,
      digestBacklog: heldLines,
      droppedBatches: this.queue.dropped,
    });
    this.queue.dropped = 0;
  }
}
