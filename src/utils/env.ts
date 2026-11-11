/**
 * A positive integer from the environment, or `fallback` when unset or invalid.
 *
 * Only digits count. Read with parseInt, `60s` was 60 and `1e5` was 1: a lock wait meant to be
 * a minute became 60 ms, and every write that met a lock failed. A value that is not a plain
 * number is now left out, like any other invalid one.
 */
export function positiveIntEnv(name: string, fallback: number): number {
  const text = (process.env[name] ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** True unless the variable is set to the string 'false': a switch that is on by default. */
export function enabledUnlessFalseEnv(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() !== 'false';
}

/**
 * PROCESS_ROLE=elysium-worker: this process runs the Elysium ingestion (and its
 * day rollups) and nothing else. Unset, or any other value: everything, as before.
 */
export function isElysiumWorker(): boolean {
  return process.env.PROCESS_ROLE?.trim().toLowerCase() === 'elysium-worker';
}
