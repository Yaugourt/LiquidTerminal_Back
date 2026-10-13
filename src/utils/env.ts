/** A positive integer from the environment, or `fallback` when unset or invalid. */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
