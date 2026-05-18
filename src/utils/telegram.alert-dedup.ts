import { logDeduplicator } from './logDeduplicator';

/**
 * Shared deduplication / back-pressure helpers for the Telegram alert dispatchers
 * (liquidation, wallet, fill).
 *
 * Background — these helpers fix a connection-pool exhaustion incident:
 *  - WS re-flushes and reconnects re-dispatched the same events, so every
 *    duplicate did a wasted DB round-trip ("insert + catch P2002").
 *  - The dispatch callbacks ran without serialization, so slow batches
 *    overlapped and each held its own DB connections until the pool drained.
 *  - The duplicate-detection `catch {}` swallowed connection timeouts and
 *    treated them as "already sent", silently dropping real alerts.
 */

/** Outcome of attempting to record an alert as sent. */
export type MarkSentResult = 'new' | 'duplicate' | 'error';

/** True if the error is a Prisma P2002 unique-constraint violation. */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Attempt an atomic "mark as sent" insert and classify the outcome.
 * - `new`       → row inserted; the alert has not been sent before.
 * - `duplicate` → P2002 unique-constraint violation; already sent.
 * - `error`     → any other failure (e.g. connection timeout). The caller MUST
 *                 fail OPEN (send the alert anyway) rather than drop it silently.
 */
export async function markAlertSent(
  insert: () => Promise<unknown>,
  context: string
): Promise<MarkSentResult> {
  try {
    await insert();
    return 'new';
  } catch (error) {
    if (isUniqueConstraintError(error)) return 'duplicate';
    logDeduplicator.error(`${context}: markSent DB error — failing open (alert will be sent)`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
}

/**
 * Bounded in-memory set of recently-seen dedup keys with FIFO eviction.
 * Absorbs repeated events (WS re-flush / reconnect) so the database is hit at
 * most once per key — the primary guard against connection-pool exhaustion.
 */
export class RecentEventCache {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize: number = 50_000) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.order.push(key);
    if (this.order.length > this.maxSize) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.keys.delete(evicted);
    }
  }

  clear(): void {
    this.keys.clear();
    this.order.length = 0;
  }
}

/**
 * Serializes async batches into a single non-overlapping chain, so dispatch
 * batches never run concurrently and the DB connection usage stays bounded.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly context: string) {}

  enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error) => {
      logDeduplicator.error(`${this.context}: queued task failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/** Rows older than this are deleted by the periodic purge. */
const SENT_ALERT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How often the purge runs. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start an hourly job that deletes sent-alert rows older than 24h, keeping the
 * dedup table from growing unbounded. `purge` receives the cutoff Date and
 * should run a `deleteMany`. Returns the timer — clear it on dispatcher stop.
 */
export function startSentAlertPurge(
  purge: (cutoff: Date) => Promise<{ count: number }>,
  context: string
): NodeJS.Timeout {
  const run = async (): Promise<void> => {
    try {
      const { count } = await purge(new Date(Date.now() - SENT_ALERT_RETENTION_MS));
      if (count > 0) {
        logDeduplicator.info(`${context}: purged ${count} stale sent-alert rows`);
      }
    } catch (error) {
      logDeduplicator.warn(`${context}: sent-alert purge failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const timer = setInterval(run, PURGE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
