import type { Pool } from 'pg';
import { rawLogger } from '../utils/logger';

/**
 * Registry of the app's pg connection pools, keyed by logical DB name, so a single
 * monitor can periodically emit each pool's saturation (total / idle / waiting).
 *
 * Why: the "Connection terminated due to connection timeout" errors never say WHICH
 * of the four databases ran out of connections. This closes that observability gap —
 * on the next incident the logs show exactly which pool is saturated.
 */
const pools = new Map<string, Pool>();

export function registerPool(name: string, pool: Pool): void {
  pools.set(name, pool);
}

let monitorStarted = false;

export function startPoolMonitor(intervalMs = 60_000): void {
  if (monitorStarted) return;
  monitorStarted = true;

  const timer = setInterval(() => {
    for (const [name, pool] of pools) {
      // total = open connections, idle = free, waiting = checkouts queued because the
      // pool is at max. waiting > 0 is the saturation signal that precedes timeouts.
      const payload = {
        pool: name,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
      // rawLogger bypasses dedup so every tick is emitted (the message is constant).
      if (pool.waitingCount > 0) {
        void rawLogger.warn(`DB pool saturated: ${name}`, payload);
      } else {
        void rawLogger.info(`DB pool stats: ${name}`, payload);
      }
    }
  }, intervalMs);

  // Don't keep the event loop alive just for metrics.
  timer.unref();
}
