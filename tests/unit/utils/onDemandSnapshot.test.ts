import { OnDemandSnapshot, SnapshotStore } from '../../../src/utils/onDemandSnapshot';

describe('OnDemandSnapshot', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const make = (fetch: () => Promise<number>) =>
    new OnDemandSnapshot(fetch, { freshMs: 1_000, maxStaleMs: 10_000 });

  it('fetches once for concurrent callers and serves the fresh value from memory', async () => {
    const fetch = jest.fn().mockResolvedValue(1);
    const snap = make(fetch);

    await expect(Promise.all([snap.get(), snap.get(), snap.get()])).resolves.toEqual([1, 1, 1]);
    await expect(snap.get()).resolves.toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves a stale value at once while one refresh runs', async () => {
    let release!: (v: number) => void;
    const fetch = jest.fn()
      .mockResolvedValueOnce(1)
      .mockReturnValueOnce(new Promise<number>((resolve) => { release = resolve; }));
    const snap = make(fetch);
    await snap.get();

    jest.advanceTimersByTime(1_500);
    await expect(snap.get()).resolves.toBe(1);
    await expect(snap.get()).resolves.toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    release(2);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await expect(snap.get()).resolves.toBe(2);
  });

  it('waits for the refresh once the value is past maxStaleMs, then frees it', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const snap = make(fetch);
    await snap.get();

    jest.advanceTimersByTime(10_001);
    expect(snap.getFetchedAt()).toBe(0);
    await expect(snap.get()).resolves.toBe(2);
  });

  it('returns null on a failed first fetch and keeps serving the stale value on a failed refresh', async () => {
    const fetch = jest.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('down'));
    const snap = make(fetch);

    await expect(snap.get()).resolves.toBeNull();
    await expect(snap.get()).resolves.toBe(1);
    jest.advanceTimersByTime(1_500);
    await expect(snap.get()).resolves.toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    await expect(snap.get()).resolves.toBe(1);
  });

  it('clear() drops the value', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const snap = make(fetch);
    await snap.get();
    snap.clear();
    await expect(snap.get()).resolves.toBe(2);
  });

  it('clear() detaches a refresh in flight: its callers get it, the snapshot does not keep it', async () => {
    let releaseOld!: (v: number) => void;
    const fetch = jest.fn()
      .mockReturnValueOnce(new Promise<number>((resolve) => { releaseOld = resolve; }))
      .mockResolvedValueOnce(2);
    const snap = make(fetch);

    const waiting = snap.get();
    snap.clear();
    // The next reader starts its own refresh instead of joining the detached one.
    await expect(snap.get()).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);

    releaseOld(1);
    await expect(waiting).resolves.toBe(1);
    // The detached result did not replace the current value.
    await expect(snap.get()).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a load that lands after clear() holds nothing (no eviction timer, nothing served)', async () => {
    let release!: (v: number) => void;
    const fetch = jest.fn()
      .mockReturnValueOnce(new Promise<number>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(2);
    const snap = make(fetch);

    const waiting = snap.get();
    snap.clear();
    release(1);
    await expect(waiting).resolves.toBe(1);
    expect(snap.getFetchedAt()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not retry a failing refresh on every read while the stale value is served', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(1).mockRejectedValue(new Error('down'));
    const snap = make(fetch);
    await snap.get();

    jest.advanceTimersByTime(1_500);
    await expect(snap.get()).resolves.toBe(1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    // Within the pause (min(freshMs, 30 s) = 1 s here): no new attempt.
    for (let i = 0; i < 5; i++) await expect(snap.get()).resolves.toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    // After it, one more.
    jest.advanceTimersByTime(1_000);
    await expect(snap.get()).resolves.toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  describe('with a store', () => {
    /** In-memory store; `saved` records what the snapshot wrote. */
    const memoryStore = (initial: { value: number; fetchedAt: number } | null = null) => {
      let entry = initial;
      const saved: Array<{ value: number; fetchedAt: number }> = [];
      const store: SnapshotStore<number> = {
        load: jest.fn(async () => entry),
        save: jest.fn(async (value: number, fetchedAt: number) => {
          entry = { value, fetchedAt };
          saved.push(entry);
        }),
      };
      return { store, saved, set: (e: { value: number; fetchedAt: number } | null) => { entry = e; } };
    };
    const withStore = (fetch: () => Promise<number>, store: SnapshotStore<number>) =>
      new OnDemandSnapshot(fetch, { freshMs: 1_000, maxStaleMs: 10_000, store });

    it('serves a fresh stored value without fetching', async () => {
      const { store } = memoryStore({ value: 7, fetchedAt: Date.now() - 500 });
      const fetch = jest.fn().mockResolvedValue(1);
      const snap = withStore(fetch, store);
      await expect(Promise.all([snap.get(), snap.get()])).resolves.toEqual([7, 7]);
      expect(fetch).not.toHaveBeenCalled();
      expect(store.load).toHaveBeenCalledTimes(1);
    });

    it('serves a stale stored value at once and refreshes it in the background', async () => {
      const { store, saved } = memoryStore({ value: 7, fetchedAt: Date.now() - 5_000 });
      const fetch = jest.fn().mockResolvedValue(8);
      const snap = withStore(fetch, store);
      await expect(snap.get()).resolves.toBe(7);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(snap.get()).resolves.toBe(8);
      expect(saved).toEqual([{ value: 8, fetchedAt: Date.now() }]);
    });

    it('ignores a stored value past maxStaleMs and saves what it fetches', async () => {
      const { store, saved } = memoryStore({ value: 7, fetchedAt: Date.now() - 20_000 });
      const snap = withStore(jest.fn().mockResolvedValue(8), store);
      await expect(snap.get()).resolves.toBe(8);
      expect(saved.map((e) => e.value)).toEqual([8]);
    });

    it('takes a fresher value another instance stored instead of fetching on refresh', async () => {
      const { store, set } = memoryStore();
      const fetch = jest.fn().mockResolvedValue(1);
      const snap = withStore(fetch, store);
      await snap.get();
      jest.advanceTimersByTime(1_500);
      set({ value: 9, fetchedAt: Date.now() - 100 });
      await snap.get();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await expect(snap.get()).resolves.toBe(9);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to the stored value when the fetch fails', async () => {
      const { store } = memoryStore({ value: 7, fetchedAt: Date.now() - 5_000 });
      const snap = withStore(jest.fn().mockRejectedValue(new Error('down')), store);
      // Evicted from memory, the stored value comes back.
      await expect(snap.get()).resolves.toBe(7);
      snap.clear();
      await expect(snap.get()).resolves.toBe(7);
    });

    it('does not read a stored value that is not newer than the one held', async () => {
      const { store } = memoryStore();
      let storedAt: number | null = null;
      store.loadFetchedAt = jest.fn(async () => storedAt);
      (store.save as jest.Mock).mockImplementation(async (_v: number, fetchedAt: number) => {
        storedAt = fetchedAt;
      });
      const fetch = jest.fn().mockResolvedValue(1);
      const snap = withStore(fetch, store);
      await snap.get();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      (store.load as jest.Mock).mockClear();

      jest.advanceTimersByTime(1_500);
      await snap.get();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // The stored value is the one this snapshot wrote: refreshed without reading it.
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(store.load).not.toHaveBeenCalled();
    });

    it('still reads a newer stored value its fetch time announces', async () => {
      const { store, set } = memoryStore();
      store.loadFetchedAt = jest.fn(async () => null);
      const fetch = jest.fn().mockResolvedValue(1);
      const snap = withStore(fetch, store);
      await snap.get();
      jest.advanceTimersByTime(1_500);
      const at = Date.now() - 100;
      set({ value: 9, fetchedAt: at });
      store.loadFetchedAt = jest.fn(async () => at);
      await snap.get();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await expect(snap.get()).resolves.toBe(9);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('never gives the eviction timer a delay that overflows (stored fetch time in the future)', async () => {
      // Written by an instance whose clock is ahead: Node fires a delay past 2^31-1 ms after 1 ms.
      const { store } = memoryStore({ value: 7, fetchedAt: Date.now() + 30 * 86_400_000 });
      const timerSpy = jest.spyOn(global, 'setTimeout');
      try {
        const snap = withStore(jest.fn().mockResolvedValue(1), store);
        await expect(snap.get()).resolves.toBe(7);
        const delays = timerSpy.mock.calls.map(([, ms]) => ms ?? 0);
        expect(delays.length).toBeGreaterThan(0);
        expect(Math.max(...delays)).toBeLessThanOrEqual(2 ** 31 - 1);
      } finally {
        timerSpy.mockRestore();
      }
    });

    it('treats a throwing store as empty', async () => {
      const store: SnapshotStore<number> = {
        load: jest.fn().mockRejectedValue(new Error('redis down')),
        save: jest.fn().mockRejectedValue(new Error('redis down')),
      };
      const snap = withStore(jest.fn().mockResolvedValue(3), store);
      await expect(snap.get()).resolves.toBe(3);
    });

    it('evicts a stored value when it reaches maxStaleMs, not maxStaleMs after loading it', async () => {
      const { store, set } = memoryStore({ value: 7, fetchedAt: Date.now() - 9_000 });
      const snap = withStore(jest.fn().mockRejectedValue(new Error('down')), store);
      await expect(snap.get()).resolves.toBe(7);
      set(null);
      jest.advanceTimersByTime(1_001);
      expect(snap.getFetchedAt()).toBe(0);
    });
  });
});
