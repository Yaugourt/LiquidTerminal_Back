export interface OnDemandSnapshotOptions {
  /** Served as-is while younger than this. */
  freshMs: number;
  /**
   * Past `freshMs` and up to this age the value is still served while one
   * refresh runs in the background; past it, callers wait for the refresh and
   * the value is dropped.
   */
  maxStaleMs: number;
}

interface Snapshot<T> {
  value: T;
  fetchedAt: number;
}

/**
 * A value fetched only while someone asks for it, never polled: fresh values
 * are served from memory, stale ones are served while a single refresh runs,
 * and a value nobody read for `maxStaleMs` is freed. Same scheme as the
 * leaderboard client, for payloads too big to keep in Redis or to poll.
 *
 * A failed refresh resolves to null (the stale value, if any, keeps being
 * served until it expires) — `fetch` logs its own errors.
 */
export class OnDemandSnapshot<T> {
  private snapshot: Snapshot<T> | null = null;
  private inflight: Promise<Snapshot<T> | null> | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;
  /** Bumped by clear(): a load started before it is not kept. */
  private generation = 0;

  constructor(
    private readonly fetch: () => Promise<T>,
    private readonly options: OnDemandSnapshotOptions
  ) {}

  public async get(): Promise<T | null> {
    const snapshot = this.snapshot;
    const age = snapshot ? Date.now() - snapshot.fetchedAt : Infinity;

    if (snapshot && age < this.options.freshMs) {
      return snapshot.value;
    }
    if (snapshot && age < this.options.maxStaleMs) {
      void this.refresh();
      return snapshot.value;
    }

    const fresh = await this.refresh();
    return fresh ? fresh.value : null;
  }

  /** Fetch time of the value currently held, 0 when none. */
  public getFetchedAt(): number {
    return this.snapshot?.fetchedAt ?? 0;
  }

  /**
   * Drops the value and its timer. A refresh in flight is detached: its
   * callers still get its result, but it is not kept, and the next get()
   * starts a new one.
   */
  public clear(): void {
    if (this.evictionTimer) clearTimeout(this.evictionTimer);
    this.evictionTimer = null;
    this.snapshot = null;
    this.inflight = null;
    this.generation++;
  }

  /** One upstream fetch at a time, whatever the number of callers. */
  private refresh(): Promise<Snapshot<T> | null> {
    if (!this.inflight) {
      const inflight = this.load(this.generation).finally(() => {
        if (this.inflight === inflight) this.inflight = null;
      });
      this.inflight = inflight;
    }
    return this.inflight;
  }

  private async load(generation: number): Promise<Snapshot<T> | null> {
    try {
      const snapshot: Snapshot<T> = { value: await this.fetch(), fetchedAt: Date.now() };
      // Cleared while loading: an evicted or outdated value is not held again.
      if (generation === this.generation) {
        this.snapshot = snapshot;
        this.scheduleEviction(snapshot);
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  /** A value past maxStaleMs is never served again: free it instead of holding it. */
  private scheduleEviction(snapshot: Snapshot<T>): void {
    if (this.evictionTimer) clearTimeout(this.evictionTimer);
    this.evictionTimer = setTimeout(() => {
      this.evictionTimer = null;
      if (this.snapshot === snapshot) this.snapshot = null;
    }, this.options.maxStaleMs);
    this.evictionTimer.unref();
  }
}
