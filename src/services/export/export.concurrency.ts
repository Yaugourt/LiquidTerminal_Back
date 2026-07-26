import { logDeduplicator } from '../../utils/logDeduplicator';
import {
  EXPORT_MAX_CONCURRENT,
  EXPORT_QUEUE_MAX_WAIT_MS,
  EXPORT_QUEUE_MAX_DEPTH,
} from '../../constants/export.constants';

/**
 * Global gate on how many exports run at once.
 *
 * The per-user quota bounds one person, not the server: fifty users each
 * spending their single daily export still means fifty simultaneous walks. And
 * an export is not a normal request — it makes ~100 sequential upstream calls
 * over a minute or two, so it holds a slot of the process-wide outbound pool
 * (50, shared by every client) for that entire time, and the pool's queue has
 * no timeout. Enough of them and every other call in the backend — pollers
 * included — waits forever. That is the shape of the stalls this service has
 * had before.
 *
 * So exports queue behind a small semaphore, and the queue itself is bounded:
 * a caller waits a little, then is told to come back rather than holding a
 * connection open indefinitely.
 */

let active = 0;
const waiting: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

export class ExportBusyError extends Error {
  public readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Export capacity reached');
    this.name = 'ExportBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Rough wait for the caller, based on how many are ahead. */
function estimateRetrySeconds(): number {
  const ahead = active + waiting.length;
  return Math.min(300, Math.max(30, Math.ceil((ahead / EXPORT_MAX_CONCURRENT) * 60)));
}

/**
 * Claims a slot, waiting up to EXPORT_QUEUE_MAX_WAIT_MS.
 * @throws ExportBusyError when the queue is full or the wait runs out.
 */
export async function acquireExportSlot(): Promise<void> {
  if (active < EXPORT_MAX_CONCURRENT) {
    active += 1;
    return;
  }

  if (waiting.length >= EXPORT_QUEUE_MAX_DEPTH) {
    logDeduplicator.warn('Export queue full', { active, queued: waiting.length });
    throw new ExportBusyError(estimateRetrySeconds());
  }

  const retryAfter = estimateRetrySeconds();

  await new Promise<void>((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index !== -1) waiting.splice(index, 1);
        reject(new ExportBusyError(retryAfter));
      }, EXPORT_QUEUE_MAX_WAIT_MS),
    };
    waiting.push(entry);
  });

  active += 1;
}

/** Returns a slot and hands it to whoever has waited longest. */
export function releaseExportSlot(): void {
  active = Math.max(0, active - 1);

  const next = waiting.shift();
  if (!next) return;
  clearTimeout(next.timer);
  next.resolve();
}

/** Snapshot for logs and diagnostics. */
export function exportConcurrencySnapshot(): { active: number; queued: number; capacity: number } {
  return { active, queued: waiting.length, capacity: EXPORT_MAX_CONCURRENT };
}
