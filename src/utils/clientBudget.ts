/**
 * A budget per client over fixed windows, held in this process.
 *
 * For work that costs THIS process (event-loop time, memory) before any
 * route-level limiter has run: the count has to be synchronous and must not
 * depend on Redis, so it lives here. It is per process on purpose: what it
 * protects is this process's own loop, so two instances each keep their own.
 *
 * Memory is bounded: at most `maxClients` entries, the oldest one leaves when
 * a new client arrives at the cap.
 */
export class ClientBudget {
  private readonly entries = new Map<string, { window: number; used: number }>();

  constructor(
    /** Units a client may take in one window. */
    public readonly limit: number,
    private readonly windowMs: number,
    private readonly maxClients = 10_000
  ) {}

  private windowOf(now: number): number {
    return Math.floor(now / this.windowMs);
  }

  /** Units `key` can still take in the current window. */
  public remaining(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry || entry.window !== this.windowOf(now)) return this.limit;
    return Math.max(0, this.limit - entry.used);
  }

  /** Takes `units` from the budget of `key`; false (and nothing taken) when it does not have them. */
  public take(key: string, units: number, now = Date.now()): boolean {
    const window = this.windowOf(now);
    const entry = this.entries.get(key);
    if (entry && entry.window === window) {
      if (entry.used + units > this.limit) return false;
      entry.used += units;
      return true;
    }
    if (units > this.limit) return false;
    if (!entry && this.entries.size >= this.maxClients) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    // Re-inserted, so a client seen again is the newest entry.
    this.entries.delete(key);
    this.entries.set(key, { window, used: units });
    return true;
  }

  /** Whole seconds until the current window rolls over, at least 1: what a refused client is told to wait. */
  public retryAfterS(now = Date.now()): number {
    return Math.max(1, Math.ceil((this.windowMs - (now % this.windowMs)) / 1000));
  }

  /** Clients currently tracked (tests, diagnostics). */
  public get size(): number {
    return this.entries.size;
  }
}
