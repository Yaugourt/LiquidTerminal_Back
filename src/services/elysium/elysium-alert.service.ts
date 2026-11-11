import { redisService } from '../../core/redis.service';
import { withDistributedLock } from '../../utils/distributedLock';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ElysiumAnalyticsService } from './elysium-analytics.service';

/** How often the conditions are looked at. */
const CHECK_EVERY_MS = 60_000;
/** A condition that still holds is said again this often. */
const REPEAT_EVERY_MS = 6 * 3_600_000;
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
/** The share of the database volume in use past which a message goes. */
const DATABASE_SHARE = 0.8;

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

/**
 * What is wrong right now, from what the status route says: a stream that fails, does not run
 * or is behind; the provider standing still; rollups that wait or fail; a closed day that
 * differs from the provider; rows left out that should not be; a one-time job or a view in
 * error; an abnormal day of credits; a database volume filling up.
 */
export function alertConditions(status: Status, now: number): AlertCondition[] {
  const out: AlertCondition[] = [];
  const today = new Date(now).toISOString().slice(0, 10);
  const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

  for (const s of status.streams) {
    const state = text(s.state);
    if (state !== 'failing' && state !== 'stalled' && state !== 'behind') continue;
    const lag = typeof s.lagSeconds === 'number' ? `, data ${minutes(s.lagSeconds)} old` : '';
    const error = s.lastError ? `, last error: ${text(s.lastError)}` : '';
    out.push({ key: `stream:${text(s.stream)}`, forS: 180, text: `stream ${text(s.stream)} is ${state}${lag}${error}` });
  }

  const providerLag = status.provider?.lagSeconds;
  if (typeof providerLag === 'number' && providerLag > 600) {
    out.push({
      key: 'provider',
      forS: 0,
      text: `the provider's index has not moved for ${minutes(providerLag)} (its last block: ${text(status.provider.headAt)}). The tx and bridge streams wait for it; live data comes from the RPC meanwhile`,
    });
  }

  if (status.rollups?.lastError) out.push({ key: 'rollups:error', forS: 600, text: `the day rollups fail: ${text(status.rollups.lastError)}` });
  if (typeof status.rollups?.waitingDays === 'number' && status.rollups.waitingDays > 1) {
    out.push({ key: 'rollups:waiting', forS: 1800, text: `${status.rollups.waitingDays} closed days wait for their rollups` });
  }

  const days = (status.completeness?.days ?? []) as Array<Record<string, unknown>>;
  for (const d of days) {
    if (d.status === 'ok') continue;
    out.push({
      key: `day:${text(d.day)}`,
      forS: 0,
      text: `${text(d.day)} differs from the provider (${text(d.status)}): ${text(d.txs)} transactions here, ${text(d.providerTxs)} there; spam ${text(d.spam)} here, ${text(d.providerSpam)} there`,
    });
  }

  for (const r of status.rejects ?? []) {
    if (!REJECTS_WORTH_A_MESSAGE.has(text(r.reason)) || !(Number(r.today) > 0)) continue;
    out.push({
      key: `reject:${text(r.stream)}:${text(r.reason)}:${today}`,
      forS: 0,
      endsQuietly: true,
      text: `${text(r.today)} ${text(r.reason)} on the ${text(r.stream)} stream today (the example is in elysium_ingest_reject)`,
    });
  }

  for (const u of status.upkeep ?? []) {
    if (u.lastError) out.push({ key: `upkeep:${text(u.name)}`, forS: 600, text: `the job ${text(u.name)} fails: ${text(u.lastError)}` });
  }
  for (const v of status.views ?? []) {
    if (v.lastError) out.push({ key: `view:${text(v.view)}`, forS: 600, text: `the view ${text(v.view)} fails: ${text(v.lastError)}` });
  }

  const credits = (status.credits?.days ?? []) as Array<{ day: string; credits: number | null }>;
  const before = credits.slice(1).map((d) => d.credits).filter((c): c is number => typeof c === 'number' && c > 0);
  const spent = credits[0]?.credits;
  if (typeof spent === 'number' && before.length >= 3 && spent > CREDITS_FACTOR * Math.max(...before)) {
    out.push({
      key: `credits:${today}`,
      forS: 0,
      endsQuietly: true,
      text: `${Math.round(spent).toLocaleString('en-US')} HypeDexer credits spent today, over ${CREDITS_FACTOR} times the highest of the last ${before.length} days (${Math.round(Math.max(...before)).toLocaleString('en-US')})`,
    });
  }

  const share = status.database?.usedShare;
  if (typeof share === 'number' && share >= DATABASE_SHARE) {
    out.push({ key: 'database', forS: 0, text: `the historical database fills ${Math.round(share * 100)}% of its volume` });
  }
  return out;
}

interface Held {
  since: number;
  sentAt: number | null;
  quiet?: boolean;
}

/**
 * Tells someone when the Elysium ingestion needs a look.
 *
 * The backend could say nothing to anyone: the provider's outage of 17 October was seen by
 * chance, days later. Once a minute this reads the status the route serves, and sends a message
 * to a webhook (ELYSIUM_ALERT_WEBHOOK_URL: a Discord or Slack webhook, or Telegram's sendMessage
 * with ELYSIUM_ALERT_TELEGRAM_CHAT_ID) when a condition has held for long enough, again every
 * six hours while it holds, and once when it is over. Without a URL the same lines go to the log.
 *
 * What was said is kept in Redis, so a restart says nothing twice, and one process at a time
 * looks (a lock).
 */
export class ElysiumAlertService {
  private static instance: ElysiumAlertService;
  private timer: NodeJS.Timeout | null = null;

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
    logDeduplicator.info('Elysium alerts started', { webhook: Boolean(process.env.ELYSIUM_ALERT_WEBHOOK_URL?.trim()) });
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look. Never throws: a failure here must not become one more thing to be told about. */
  public async tick(): Promise<void> {
    try {
      await withDistributedLock('poll:elysium-alerts', 50, () => this.look());
    } catch (error) {
      logDeduplicator.warn('Elysium alerts: look failed', { errorType: error instanceof Error ? error.name : typeof error });
    }
  }

  private async look(): Promise<void> {
    const now = Date.now();
    const status = (await ElysiumAnalyticsService.getInstance().getStatus()).data;
    const active = new Map(alertConditions(status, now).map((c) => [c.key, c]));
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
      const due = state.sentAt === null ? now - state.since >= condition.forS * 1000 : now - state.sentAt >= REPEAT_EVERY_MS;
      if (due) {
        const still = state.sentAt === null ? '' : ` (still, for ${minutes((now - state.since) / 1000)})`;
        if (await this.send(`[Elysium] ${condition.text}${still}`)) state.sentAt = now;
      }
      await client.hset(STATE_KEY, key, JSON.stringify(state));
    }
    for (const [key, state] of held) {
      if (active.has(key)) continue;
      // Over. Said only when its start was said, and when it is not a condition of one day.
      if (state.sentAt !== null && !state.quiet) await this.send(`[Elysium] over: ${key.replace(/^(stream|day|view|upkeep):/, '$1 ')} (after ${minutes((now - state.since) / 1000)})`);
      await client.hdel(STATE_KEY, key);
    }
    await client.expire(STATE_KEY, STATE_TTL_S);
  }

  /** Sends one line; true when it went (or when there is nowhere to send it and it was logged). */
  private async send(text: string): Promise<boolean> {
    const url = process.env.ELYSIUM_ALERT_WEBHOOK_URL?.trim();
    if (!url) {
      logDeduplicator.warn('Elysium alert (no webhook set)', { text });
      return true;
    }
    try {
      const chat = process.env.ELYSIUM_ALERT_TELEGRAM_CHAT_ID?.trim();
      // Telegram's sendMessage takes the chat and the text; Discord reads `content`, Slack `text`.
      const body = chat ? { chat_id: chat, text, disable_web_page_preview: true } : { content: text, text };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (error) {
      // The address holds a secret: never logged.
      logDeduplicator.warn('Elysium alerts: message not sent, tried again at the next look', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }
}
