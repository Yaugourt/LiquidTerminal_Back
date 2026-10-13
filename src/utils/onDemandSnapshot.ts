interface Snapshot<T> {
  value: T;
  fetchedAt: number;
}

/**
 * Where a snapshot's last value survives eviction, restarts and other
 * instances (Redis). Failures are the store's own business: `load` resolving
 * null or throwing both mean "nothing stored".
 */
export interface SnapshotStore<T> {
  load(): Promise<Snapshot<T> | null>;
  save(value: T, fetchedAt: number): Promise<void>;
  /**
   * Optional: the stored value's fetch time, read without the value (null
   * when unknown). A refresh then skips reading and decoding a stored value
   * that is not newer than the one held: on a single instance, the value
   * this process wrote itself.
   */
  loadFetchedAt?(): Promise<number | null>;
}

/** Longest delay setTimeout honours (a longer one fires after 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Default pause after a failed refresh while a value can still be served: min(freshMs, this). */
const DEFAULT_RETRY_AFTER_FAILURE_MS = 30_000;

export interface OnDemandSnapshotOptions<T = unknown> {
  /** Served as-is while younger than this. */
  freshMs: number;
  /**
   * Past `freshMs` and up to this age the value is still served while one
   * refresh runs in the background; past it, callers wait for the refresh and
   * the value is dropped.
   */
  maxStaleMs: number;
  /**
   * Optional persistence. With it, a snapshot holding nothing first takes the
   * stored value (when younger than `maxStaleMs`) instead of waiting for a
   * fetch, a refresh takes a stored value fresher than `freshMs` (written by
   * another instance) instead of fetching, a failed refresh falls back to a
   * newer stored value, and every fetched value is saved.
   */
  store?: SnapshotStore<T>;
  /**
   * After a failed refresh, while a value is still served, no new refresh
   * starts for this long (default min(freshMs, 30 s)): a failing upstream
   * is not asked again on every read. Nothing held: callers still wait for
   * a fetch.
   */
  retryAfterFailureMs?: number;
}

/**
 * A value fetched only while someone asks for it, never polled: fresh values
 * are served from memory, stale ones are served while a single refresh runs,
 * and a value nobody read for `maxStaleMs` is freed. Same scheme as the
 * leaderboard client, for payloads too big to poll. An optional store
 * (Redis) keeps the last value across evictions, restarts and instances.
 *
 * A failed refresh resolves to null (the stale value, if any, keeps being
 * served until it expires) — `fetch` logs its own errors.
 */
export class OnDemandSnapshot<T> {
  private snapshot: Snapshot<T> | null = null;
  private inflight: Promise<Snapshot<T> | null> | null = null;
  private hydrating: Promise<void> | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;
  /** Bumped by clear(): a load started before it is not kept. */
  private generation = 0;
  /** When the last refresh failed (0 after a success). */
  private failedAt = 0;

  constructor(
    private readonly fetch: () => Promise<T>,
    private readonly options: OnDemandSnapshotOptions<T>
  ) {}

  public async get(): Promise<T | null> {
    if (!this.snapshot && this.options.store) await this.hydrate();
    const snapshot = this.snapshot;
    const age = snapshot ? Date.now() - snapshot.fetchedAt : Infinity;

    if (snapshot && age < this.options.freshMs) {
      return snapshot.value;
    }
    if (snapshot && age < this.options.maxStaleMs) {
      if (!this.backingOff()) void this.refresh();
      return snapshot.value;
    }

    const fresh = await this.refresh();
    return fresh ? fresh.value : null;
  }

  /**
   * With a store and nothing held: takes the stored value if it is younger
   * than maxStaleMs. Concurrent callers share one read; no-op otherwise.
   */
  public hydrate(): Promise<void> {
    if (this.snapshot || !this.options.store) return Promise.resolve();
    if (!this.hydrating) {
      const generation = this.generation;
      const hydrating = this.readStore()
        .then((stored) => {
          if (stored && !this.snapshot && this.isServable(stored)) this.keep(stored, generation);
        })
        .finally(() => {
          if (this.hydrating === hydrating) this.hydrating = null;
        });
      this.hydrating = hydrating;
    }
    return this.hydrating;
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
    this.hydrating = null;
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
    const store = this.options.store;
    const heldAt = this.snapshot?.fetchedAt ?? 0;
    // The stored value is only read (and decoded) when it may be newer than
    // the one held and young enough to use; unknown fetch time: read it.
    const storedAt = store ? await this.readStoredAt() : null;
    const storeMayHave = (maxAgeMs: number): boolean =>
      store !== undefined && (storedAt === null || (storedAt > heldAt && Date.now() - storedAt < maxAgeMs));

    let stored: Snapshot<T> | null = null;
    let storeRead = false;
    // Refreshed elsewhere (another instance, a warmer): take it, don't fetch.
    if (storeMayHave(this.options.freshMs)) {
      stored = await this.readStore();
      storeRead = true;
      if (stored && Date.now() - stored.fetchedAt < this.options.freshMs) {
        this.keep(stored, generation);
        return stored;
      }
    }
    try {
      const snapshot: Snapshot<T> = { value: await this.fetch(), fetchedAt: Date.now() };
      this.failedAt = 0;
      this.keep(snapshot, generation);
      if (store) {
        store.save(snapshot.value, snapshot.fetchedAt).catch(() => undefined);
      }
      return snapshot;
    } catch {
      this.failedAt = Date.now();
      // A stored value newer than the one held is still better than nothing.
      if (!storeRead && storeMayHave(this.options.maxStaleMs)) stored = await this.readStore();
      if (stored && this.isServable(stored) && stored.fetchedAt > (this.snapshot?.fetchedAt ?? 0)) {
        this.keep(stored, generation);
        return stored;
      }
      return null;
    }
  }

  /** Within the pause after a failed refresh (see retryAfterFailureMs). */
  private backingOff(): boolean {
    if (this.failedAt === 0) return false;
    const pauseMs =
      this.options.retryAfterFailureMs ?? Math.min(this.options.freshMs, DEFAULT_RETRY_AFTER_FAILURE_MS);
    return Date.now() - this.failedAt < pauseMs;
  }

  private async readStoredAt(): Promise<number | null> {
    const store = this.options.store;
    if (!store?.loadFetchedAt) return null;
    try {
      const at = await store.loadFetchedAt();
      return typeof at === 'number' && Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  /** Holds `snapshot` unless the snapshot was cleared since `generation` (an evicted or outdated value is not held again). */
  private keep(snapshot: Snapshot<T>, generation: number): void {
    if (generation !== this.generation) return;
    this.snapshot = snapshot;
    this.scheduleEviction(snapshot);
  }

  private isServable(snapshot: Snapshot<T>): boolean {
    return Date.now() - snapshot.fetchedAt < this.options.maxStaleMs;
  }

  private async readStore(): Promise<Snapshot<T> | null> {
    try {
      return (await this.options.store?.load()) ?? null;
    } catch {
      return null;
    }
  }

  /** A value past maxStaleMs is never served again: free it instead of holding it. */
  private scheduleEviction(snapshot: Snapshot<T>): void {
    if (this.evictionTimer) clearTimeout(this.evictionTimer);
    // A stored value arrives already aged. Clamped: a fetch time in the
    // future (clock skew between instances) must not overflow the timer,
    // which would then fire at once.
    const remaining = Math.min(
      MAX_TIMER_MS,
      Math.max(1, snapshot.fetchedAt + this.options.maxStaleMs - Date.now())
    );
    this.evictionTimer = setTimeout(() => {
      this.evictionTimer = null;
      if (this.snapshot === snapshot) this.snapshot = null;
    }, remaining);
    this.evictionTimer.unref();
  }
}
