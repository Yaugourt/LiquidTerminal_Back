/**
 * Decides whether a stream of unhandled promise rejections has become a storm.
 *
 * A single stray rejection should not take the whole process down: on one
 * instance that turns any reliably-reachable rejection into a one-request
 * outage (a DoS). We log it and keep serving. Only a sustained burst, which
 * points to a corrupted or looping state rather than a one-off, is worth a
 * restart. This holds the sliding-window count so app.ts stays declarative and
 * the threshold is unit-tested.
 */
export class RejectionGuard {
  private readonly events: number[] = [];

  constructor(private readonly maxPerWindow: number, private readonly windowMs: number) {}

  /**
   * Records a rejection at `now` (epoch ms) and returns true when the number in
   * the trailing window has passed `maxPerWindow` — the signal to restart.
   */
  record(now: number): boolean {
    this.events.push(now);
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0] < cutoff) {
      this.events.shift();
    }
    return this.events.length > this.maxPerWindow;
  }
}
