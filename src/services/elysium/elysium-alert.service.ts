import { redisService } from '../../core/redis.service';
import { withDistributedLock } from '../../utils/distributedLock';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ElysiumAnalyticsService } from './elysium-analytics.service';

/** How often the conditions are looked at. */
const CHECK_EVERY_MS = 60_000;
/** A condition that still holds is said again this often. */
const REPEAT_EVERY_MS = 6 * 3_600_000;
/**
 * A condition is over once it has been gone for this long. Without it, one look where a stream
 * happens to be between two failures ended the condition: a stream that failed every other run
 * never held for long enough to be said, and one that had been said sent "over", then "failing"
 * again three minutes later.
 */
const CLEAR_AFTER_MS = 5 * 60_000;
/** A status computed longer ago than this is not the state of things any more: nothing is concluded from it. */
const STATUS_STALE_MS = 5 * 60_000;
/** A window table is refreshed once an hour: one not refreshed for this long is not being kept up. */
const WINDOW_STALE_MS = 3 * 3_600_000;
/** Looks that fail in a row before saying that nothing is being watched. */
const BLIND_AFTER_LOOKS = 5;
const STATE_KEY = 'elysium:alerts';
const STATE_TTL_S = 14 * 24 * 3600;
const SEND_TIMEOUT_MS = 10_000;

/** What is left out of the ingestion and should never be: one of these in a day is worth a look. */
const REJECTS_WORTH_A_MESSAGE: ReadonlySet<string> = new Set([
  'launch-unknown-emitter',
  'market-unknown',
  'row-refused',
  'window-truncated',
  'reorg',
]);
/** Today's credits over this many times the highest of the previous days is not a normal day. */
const CREDITS_FACTOR = 1.3;
/**
 * The same by the hour, so that a call that starts repeating is said within the hour and not
 * when the day's total passes the days before (a spend three times the usual from 18:00 took
 * until 22:30 that way): the hour that is running, over this many times the highest completed
 * hour of the seven days before. The highest, not the usual one: the registry walk, the bridge's
 * wide passes and a busy hour of visitors are all in it already.
 */
const CREDITS_HOUR_FACTOR = 1.5;
/** Completed hours that have to be known before an hour is compared with them (two days). */
const CREDITS_HOURS_KNOWN = 48;
/**
 * The balance the provider gives, in days of the usual spend, under which a message goes. The
 * allocation is not written anywhere we can read: the balance is what is left of it (999.45
 * billion credits on 2026-11-12, centuries at the rate of that day). If it ever becomes a
 * monthly figure, this says so a month before it runs out.
 */
const CREDITS_BALANCE_DAYS = 30;
/** The share of the database volume in use past which a message goes. */
const DATABASE_SHARE = 0.8;
/** A day that differs and is being read again is said only if it is still not equal after this long. */
const DAY_REPAIR_S = 3 * 3600;

export interface AlertCondition {
  /** What the condition is about: one message when it starts, one when it ends. */
  key: string;
  text: string;
  /** How long it has to hold before a message goes (a tick that fails once is not news). */
  forS: number;
  /** A condition of one day (a count, a spend): it ends with the day, without a message. */
  endsQuietly?: boolean;
}

type Status = Awaited<ReturnType<ElysiumAnalyticsService['getStatus']>>['data'];

const minutes = (seconds: number): string => (seconds >= 7200 ? `${Math.round(seconds / 3600)} h` : `${Math.round(seconds / 60)} min`);
const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** The parts of the status that could not be read when it was computed (a query that failed). */
function partial(status: Status): ReadonlySet<string> {
  return new Set(Array.isArray(status.partial) ? status.partial.map(text) : []);
}

/**
 * What is wrong right now, from what the status says: a stream that fails, does not run or is
 * behind; the provider standing still; rollups that wait or fail; a closed day that differs
 * from the provider; rows left out that should not be; a one-time job or a view in error; an
 * abnormal day or hour of credits, a balance that runs low; a database volume filling up.
 *
 * `computedAt` is when the status was computed. Older than STATUS_STALE_MS, nothing is concluded
 * from it but that it is old; and a part of it that could not be read (`status.partial`) is left
 * out. `alertUnknown` names what is in that case, so that nothing is taken for over either.
 */
export function alertConditions(status: Status, now: number, computedAt: number = now): AlertCondition[] {
  const out: AlertCondition[] = [];
  const missing = partial(status);
  const stale = now - computedAt > STATUS_STALE_MS;
  // The day the status counts "today" from: the look can fall just after midnight on a status
  // computed just before it, and yesterday's counts must not be said again under the new day.
  const statusDay = new Date(computedAt).toISOString().slice(0, 10);

  if (stale) {
    out.push({
      key: 'status',
      forS: 0,
      text: `the status of the ingestion has not been computed for ${minutes((now - computedAt) / 1000)}: the streams, the days and the credits are not being watched meanwhile`,
    });
  } else {
    for (const s of status.streams) {
      const state = text(s.state);
      if (state !== 'failing' && state !== 'stalled' && state !== 'behind') continue;
      const everyS = typeof s.everyS === 'number' ? s.everyS : 60;
      const lag = typeof s.lagSeconds === 'number' ? `, data ${minutes(s.lagSeconds)} old` : '';
      const error = s.lastError ? `, last error: ${text(s.lastError)}` : '';
      out.push({
        key: `stream:${text(s.stream)}`,
        // A run that failed leaves its stream "failing" until its next run, which waits twice the
        // stream's period: one failed run of a stream that runs every 15 minutes is not news.
        forS: state === 'failing' ? Math.max(180, 3 * everyS) : 180,
        text: `stream ${text(s.stream)} is ${state}${lag}${error}`,
      });
    }

    const providerLag = status.provider?.lagSeconds;
    if (typeof providerLag === 'number' && providerLag > 600) {
      out.push({
        key: 'provider',
        forS: 0,
        text: `the provider's index has not moved for ${minutes(providerLag)} (its last block: ${text(status.provider.headAt)}). The tx and bridge streams wait for it; live data comes from the RPC meanwhile`,
      });
    }

    if (status.rollups?.lastError) out.push({ key: 'rollups:error', forS: 600, text: `the rollups fail: ${text(status.rollups.lastError)}` });
    // A window table that is not ready, or not refreshed for hours: the views of its span still
    // say the right figures, computed from the rollups, in tens of seconds instead of one.
    if (!missing.has('rollups') && Array.isArray(status.rollups?.windows)) {
      for (const w of status.rollups.windows as Array<Record<string, unknown>>) {
        const refreshed = typeof w.refreshedAt === 'string' ? Date.parse(w.refreshedAt) : NaN;
        if (w.ready !== true || !(now - refreshed < WINDOW_STALE_MS)) {
          out.push({
            key: `rollups:window:${text(w.span)}`,
            forS: 3600,
            text: `the window table of ${text(w.span)} day(s) is not kept up: its views compute the slow way`,
          });
        }
      }
    }
    if (!missing.has('rollups') && typeof status.rollups?.waitingDays === 'number' && status.rollups.waitingDays > 1) {
      out.push({ key: 'rollups:waiting', forS: 1800, text: `${status.rollups.waitingDays} closed days wait for their rollups` });
    }

    if (!missing.has('completeness')) {
      for (const d of (status.completeness?.days ?? []) as Array<Record<string, unknown>>) {
        if (d.status === 'ok') continue;
        const counts = `${text(d.txs)} transactions here, ${text(d.providerTxs)} there; spam ${text(d.spam)} here, ${text(d.providerSpam)} there`;
        // Read again whole and still different: nothing more will be tried. Otherwise the daily
        // check is on it (it waits 30 minutes, then reads the day again): worth a message only
        // when that has not made the day equal after a few hours.
        const settled = d.status === 'unrepaired';
        out.push({
          key: `day:${text(d.day)}`,
          forS: settled ? 0 : DAY_REPAIR_S,
          text: settled
            ? `${text(d.day)} still differs from the provider after being read again whole: ${counts}`
            : `${text(d.day)} differs from the provider and is still not equal (${text(d.status)}): ${counts}`,
        });
      }
    }

    if (!missing.has('rejects')) {
      for (const r of status.rejects ?? []) {
        if (!REJECTS_WORTH_A_MESSAGE.has(text(r.reason)) || !(Number(r.today) > 0)) continue;
        out.push({
          key: `reject:${text(r.stream)}:${text(r.reason)}:${statusDay}`,
          forS: 0,
          endsQuietly: true,
          text: `${text(r.today)} ${text(r.reason)} on the ${text(r.stream)} stream today (the example is in elysium_ingest_reject)`,
        });
      }
    }

    for (const u of status.upkeep ?? []) {
      if (u.lastError) out.push({ key: `upkeep:${text(u.name)}`, forS: 600, text: `the job ${text(u.name)} fails: ${text(u.lastError)}` });
    }

    const credits = (status.credits?.days ?? []) as Array<{ day: string; credits: number | null }>;
    const before = credits.slice(1).map((d) => d.credits).filter((c): c is number => typeof c === 'number' && c > 0);
    const spent = credits[0]?.credits;
    if (typeof spent === 'number' && before.length >= 3 && spent > CREDITS_FACTOR * Math.max(...before)) {
      out.push({
        key: `credits:${text(credits[0].day)}`,
        forS: 0,
        endsQuietly: true,
        text: `${Math.round(spent).toLocaleString('en-US')} HypeDexer credits spent today, over ${CREDITS_FACTOR} times the highest of the last ${before.length} days (${Math.round(Math.max(...before)).toLocaleString('en-US')})`,
      });
    }

    const hours = status.credits?.hours as
      | { current?: { hour?: unknown; credits?: unknown }; highest?: { hour?: unknown; credits?: unknown } | null; known?: unknown }
      | undefined;
    const running = Number(hours?.current?.credits);
    const highest = Number(hours?.highest?.credits);
    if (
      hours?.highest &&
      Number(hours.known) >= CREDITS_HOURS_KNOWN &&
      highest > 0 &&
      running > CREDITS_HOUR_FACTOR * highest &&
      // The hour the status counts in: a look just past the hour must not say the last one again.
      text(hours.current?.hour) === new Date(computedAt).toISOString().slice(0, 13)
    ) {
      out.push({
        key: `credits:hour:${text(hours.current?.hour)}`,
        forS: 0,
        endsQuietly: true,
        text: `${Math.round(running).toLocaleString('en-US')} HypeDexer credits spent since ${text(hours.current?.hour).slice(11)}:00 UTC, over ${CREDITS_HOUR_FACTOR} times the highest hour of the last seven days (${Math.round(highest).toLocaleString('en-US')}, ${text(hours.highest.hour)}). The paths that cost the most today are in the status (credits.topPathsToday)`,
      });
    }

    const balance = status.credits?.balance;
    const usual = before.length >= 3 ? before.reduce((sum, c) => sum + c, 0) / before.length : 0;
    if (typeof balance === 'number' && balance >= 0 && usual > 0 && balance < CREDITS_BALANCE_DAYS * usual) {
      out.push({
        key: 'credits:balance',
        forS: 0,
        text: `the HypeDexer balance (${Math.round(balance).toLocaleString('en-US')} credits) covers ${Math.floor(balance / usual)} days at the rate of the last ${before.length} (${Math.round(usual).toLocaleString('en-US')} a day)`,
      });
    }

    const share = status.database?.usedShare;
    if (!missing.has('database') && typeof share === 'number' && share >= DATABASE_SHARE) {
      out.push({ key: 'database', forS: 0, text: `the historical database fills ${Math.round(share * 100)}% of its volume` });
    }
  }

  // Where the views stand is read from this process as the look is made, whatever the status's age.
  // Only the scheduled ones: a view computed on demand that failed once keeps its error until
  // someone asks for it again, which may be never.
  for (const v of status.views ?? []) {
    if (v.lastError && typeof v.everyS === 'number') out.push({ key: `view:${text(v.view)}`, forS: 600, text: `the view ${text(v.view)} fails: ${text(v.lastError)}` });
  }
  return out;
}

/**
 * The key prefixes of what this look cannot tell: a condition under one of them is neither
 * started nor ended. A query of the status that failed used to read as "nothing there": the
 * days that differed were said to be over, then said again at the next look.
 */
export function alertUnknown(status: Status, now: number, computedAt: number = now): string[] {
  if (now - computedAt > STATUS_STALE_MS) return ['stream:', 'provider', 'rollups:', 'day:', 'reject:', 'upkeep:', 'credits:', 'database'];
  const missing = partial(status);
  const out: string[] = [];
  if (missing.has('rollups')) out.push('rollups:waiting', 'rollups:window:');
  if (missing.has('completeness')) out.push('day:');
  if (missing.has('rejects')) out.push('reject:');
  if (missing.has('database')) out.push('database');
  if (status.credits === null || status.credits === undefined) out.push('credits:');
  return out;
}

interface Held {
  since: number;
  sentAt: number | null;
  quiet?: boolean;
  /** Since when the condition is no longer seen; it is over once that has lasted CLEAR_AFTER_MS. */
  goneAt?: number;
}

/**
 * Tells someone when the Elysium ingestion needs a look.
 *
 * The backend could say nothing to anyone: the provider's outage of 17 October was seen by
 * chance, days later. Once a minute this reads the status the route serves, and sends a message
 * to a webhook (ELYSIUM_ALERT_WEBHOOK_URL: a Discord or Slack webhook, or Telegram's sendMessage
 * with ELYSIUM_ALERT_TELEGRAM_CHAT_ID) when a condition has held for long enough, again every
 * six hours while it holds, and once when it has been over for five minutes. Without a URL the
 * same lines go to the log.
 *
 * What was said is kept in Redis, so a restart says nothing twice, and one process at a time
 * looks (a lock). It runs in the process that serves the API, not in an ingestion-only worker:
 * the webhook's address goes on that service.
 */
export class ElysiumAlertService {
  private static instance: ElysiumAlertService;
  private timer: NodeJS.Timeout | null = null;
  /** What this process sent, in case Redis could not be told: the same line is not sent every minute. */
  private readonly said = new Map<string, number>();
  /** Looks that failed in a row, and whether that was said. */
  private failedLooks = 0;
  private blindSaid = false;
  /** Set by a send that failed: the other messages of the same look wait for the next one. */
  private webhookDown = false;

  public static getInstance(): ElysiumAlertService {
    if (!ElysiumAlertService.instance) ElysiumAlertService.instance = new ElysiumAlertService();
    return ElysiumAlertService.instance;
  }

  public static isEnabled(): boolean {
    return (process.env.ELYSIUM_ALERTS_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  }

  public start(): void {
    if (this.timer || !ElysiumAlertService.isEnabled()) return;
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
    this.timer.unref?.();
    const url = process.env.ELYSIUM_ALERT_WEBHOOK_URL?.trim() ?? '';
    logDeduplicator.info('Elysium alerts started', { webhook: Boolean(url) });
    // Telegram answers 400 without a chat: every message would be lost, with one warning a minute as the only trace.
    if (/^https:\/\/api\.telegram\.org\//i.test(url) && !process.env.ELYSIUM_ALERT_TELEGRAM_CHAT_ID?.trim()) {
      logDeduplicator.error('Elysium alerts: the address is Telegram\'s and ELYSIUM_ALERT_TELEGRAM_CHAT_ID is not set, no message will arrive');
    }
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look. Never throws: a failure here must not become one more thing to be told about. */
  public async tick(): Promise<void> {
    this.webhookDown = false;
    try {
      // Kept for as long as the look lasts: a webhook that hangs makes it longer than the lock's own life.
      await withDistributedLock('poll:elysium-alerts', 50, () => this.look(), { renew: true });
      if (this.blindSaid && (await this.send('[Elysium] over: the status of the ingestion can be read again'))) this.blindSaid = false;
      this.failedLooks = 0;
    } catch (error) {
      this.failedLooks += 1;
      logDeduplicator.warn('Elysium alerts: look failed', { errorType: error instanceof Error ? error.name : typeof error });
      // The status cannot be read, or Redis cannot be asked: nothing is being watched, and that
      // is itself worth a message (kept in memory: Redis may be what fails).
      const again = this.failedLooks % Math.round(REPEAT_EVERY_MS / CHECK_EVERY_MS) === 0;
      if (this.failedLooks === BLIND_AFTER_LOOKS || (this.blindSaid && again)) {
        const sent = await this.send(`[Elysium] the status of the ingestion could not be read for ${this.failedLooks} min: nothing is being watched meanwhile`);
        this.blindSaid = this.blindSaid || sent;
      }
    }
  }

  private async look(): Promise<void> {
    const now = Date.now();
    const result = await ElysiumAnalyticsService.getInstance().getStatus();
    const status = result.data;
    const computedAt = Date.parse(result.computedAt);
    const asOf = Number.isFinite(computedAt) ? computedAt : now;
    const active = new Map(alertConditions(status, now, asOf).map((c) => [c.key, c]));
    const unknown = alertUnknown(status, now, asOf);
    const listedDays = new Set(((status.completeness?.days ?? []) as Array<Record<string, unknown>>).map((d) => text(d.day)));
    const client = redisService.getClient();
    const stored = await client.hgetall(STATE_KEY);
    const held = new Map<string, Held>();
    for (const [key, raw] of Object.entries(stored ?? {})) {
      try {
        held.set(key, JSON.parse(raw) as Held);
      } catch {
        /* an entry that does not read is started over */
      }
    }

    for (const [key, condition] of active) {
      const state = held.get(key) ?? { since: now, sentAt: null, quiet: condition.endsQuietly };
      delete state.goneAt;
      if (state.sentAt === null && this.said.has(key)) state.sentAt = this.said.get(key) ?? null;
      const due = state.sentAt === null ? now - state.since >= condition.forS * 1000 : now - state.sentAt >= REPEAT_EVERY_MS;
      if (due) {
        const still = state.sentAt === null ? '' : ` (still, for ${minutes((now - state.since) / 1000)})`;
        if (await this.send(`[Elysium] ${condition.text}${still}`)) {
          state.sentAt = now;
          this.said.set(key, now);
        }
      }
      await client.hset(STATE_KEY, key, JSON.stringify(state));
    }

    const forget = async (key: string): Promise<void> => {
      this.said.delete(key);
      await client.hdel(STATE_KEY, key);
    };
    for (const [key, state] of held) {
      if (active.has(key)) continue;
      // Not readable at this look: left as it is.
      if (unknown.some((prefix) => key.startsWith(prefix))) continue;
      // A count of one day ends with its day; a day that left the list of compared days was not
      // made equal, it only got old: neither is "over".
      if (state.quiet || (key.startsWith('day:') && !listedDays.has(key.slice(4)))) {
        await forget(key);
        continue;
      }
      if (state.goneAt === undefined) {
        state.goneAt = now;
        await client.hset(STATE_KEY, key, JSON.stringify(state));
        continue;
      }
      if (now - state.goneAt < CLEAR_AFTER_MS) continue;
      // Over. Said only when its start was said.
      if (state.sentAt !== null) {
        const sent = await this.send(`[Elysium] over: ${key.replace(/^(stream|day|view|upkeep):/, '$1 ')} (after ${minutes((state.goneAt - state.since) / 1000)})`);
        if (!sent) continue;
      }
      await forget(key);
    }
    await client.expire(STATE_KEY, STATE_TTL_S);
  }

  /** Sends one line; true when it went (or when there is nowhere to send it and it was logged). */
  private async send(line: string): Promise<boolean> {
    const url = process.env.ELYSIUM_ALERT_WEBHOOK_URL?.trim();
    if (!url) {
      logDeduplicator.warn('Elysium alert (no webhook set)', { text: line });
      return true;
    }
    // One send already failed at this look: the others would wait on the same webhook, ten
    // seconds each. They go at the next look.
    if (this.webhookDown) return false;
    try {
      const chat = process.env.ELYSIUM_ALERT_TELEGRAM_CHAT_ID?.trim();
      // Telegram's sendMessage takes the chat and the text; Discord reads `content`, Slack `text`.
      const body = chat ? { chat_id: chat, text: line, disable_web_page_preview: true } : { content: line, text: line };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (error) {
      this.webhookDown = true;
      // The address holds a secret: never logged.
      logDeduplicator.warn('Elysium alerts: message not sent, tried again at the next look', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }
}
