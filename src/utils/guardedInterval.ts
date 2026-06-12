import { logDeduplicator } from './logDeduplicator';

/**
 * Guarded polling loop, replacement for bare setInterval in polling clients:
 * - skips a tick when the previous run is still in flight, so a slow upstream
 *   API no longer stacks concurrent runs that exhaust DB/HTTP/Redis pools
 * - applies a random ±10% jitter to the period so pollers sharing the same
 *   nominal interval (e.g. the 10s Hyperliquid clients) drift apart instead
 *   of firing simultaneously every cycle
 *
 * Runs the task once immediately, then on the jittered interval.
 */
export function startGuardedInterval(
  name: string,
  task: () => Promise<unknown>,
  intervalMs: number
): NodeJS.Timeout {
  let inFlight = false;

  const run = (): void => {
    if (inFlight) {
      logDeduplicator.warn(`${name}: previous run still in flight — tick skipped`);
      return;
    }
    inFlight = true;
    task()
      .catch((err) =>
        logDeduplicator.error(`${name}: polling error`, {
          error: err instanceof Error ? err.message : String(err),
        })
      )
      .finally(() => {
        inFlight = false;
      });
  };

  run();
  const jitteredMs = Math.round(intervalMs * (0.9 + Math.random() * 0.2));
  return setInterval(run, jitteredMs);
}
