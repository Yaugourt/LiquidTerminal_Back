import { OnDemandSnapshot } from '../../../src/utils/onDemandSnapshot';

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
});
