/** A positive integer from the environment, or `fallback` when unset or invalid. */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** True unless the variable is set to the string 'false': a switch that is on by default. */
export function enabledUnlessFalseEnv(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() !== 'false';
}
