/**
 * ViewScheduler: requests read the last value and never start a computation;
 * the scheduler computes each view at its own period, a bounded number at a
 * time; a failed or absent Redis does not stop the views from being served.
 */
const mockRedis = {
  healthy: true,
  store: new Map<string, string>(),
  failGet: false,
  failSet: false,
};
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => mockRedis.healthy,
    get: async (key: string) => {
      if (mockRedis.failGet) throw new Error('redis get failed');
      return mockRedis.store.get(key) ?? null;
    },
    set: async (key: string, value: string) => {
      mockRedis.store.set(key, value);
    },
    getClient: () => ({
      get: async (key: string) => {
        if (mockRedis.failGet) throw new Error('redis get failed');
        return mockRedis.store.get(key) ?? null;
      },
      set: async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
        if (mockRedis.failSet) throw new Error('OOM command not allowed when used memory > maxmemory');
        if (nx === 'NX' && mockRedis.store.has(key)) return null;
        mockRedis.store.set(key, value);
        return 'OK';
      },
      eval: async (script: string, _n: number, key: string, token: string) => {
        if (mockRedis.store.get(key) !== token) return 0;
        if (script.includes("'del'")) mockRedis.store.delete(key);
        return 1;
      },
    }),
  },
}));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));

import { ViewDeadlineError, ViewScheduler, ViewWarmingError, type ViewCadence } from '../../../src/core/viewScheduler';

const T0 = Date.parse('2026-11-11T12:00:00.000Z');
const LIGHT: ViewCadence = { activeS: 60, idleS: 600 };
const HEAVY: ViewCadence = { activeS: 300, idleS: 1800, heavy: true };
const ON_DEMAND: ViewCadence = { activeS: 60, idleS: 0 };

function fresh(): ViewScheduler {
  (ViewScheduler as unknown as { instance?: ViewScheduler }).instance = undefined;
  return ViewScheduler.getInstance();
}

/** A view whose computation the test finishes by hand, or that answers a counter at once. */
function view(key: string, cadence: ViewCadence, mode: 'instant' | 'manual' = 'instant') {
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  let runs = 0;
  const compute = jest.fn(() => {
    runs += 1;
    const n = runs;
    if (mode === 'instant') return Promise.resolve({ key, n });
    return new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject }));
  });
  return { def: { key, compute, cadence }, compute, pending };
}
const seconds = (n: number): Promise<void> => jest.advanceTimersByTimeAsync(n * 1000);
const stored = (key: string): { at: number; value: unknown } | null => {
  const raw = mockRedis.store.get(`${key}:swr`);
  return raw ? JSON.parse(raw) : null;
};

describe('ViewScheduler', () => {
  let scheduler: ViewScheduler;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    mockRedis.healthy = true;
    mockRedis.failGet = false;
    mockRedis.failSet = false;
    mockRedis.store.clear();
    for (const m of Object.values(mockLog)) m.mockReset();
    scheduler = fresh();
  });
  afterEach(() => {
    scheduler.stop();
    jest.useRealTimers();
  });

  it('serves what is stored, with the time it is as of, and a request starts no computation', async () => {
    const v = view('a', LIGHT);
    // Left by the previous process, 30 s ago.
    mockRedis.store.set('a:swr', JSON.stringify({ at: T0 - 30_000, value: { old: true } }));
    scheduler.start();

    const results = await Promise.all(Array.from({ length: 100 }, () => scheduler.read(v.def)));
    expect(results[0]).toMatchObject({ data: { old: true }, computedAt: new Date(T0 - 30_000).toISOString(), refreshEveryS: 60 });
    expect(v.compute).not.toHaveBeenCalled();

    // The value is 30 s old and the view is watched: computed once it is 60 s old, not before, and once.
    await seconds(29);
    expect(v.compute).not.toHaveBeenCalled();
    await seconds(2);
    expect(v.compute).toHaveBeenCalledTimes(1);
    const next = await scheduler.read(v.def);
    expect(next.data).toEqual({ key: 'a', n: 1 });
    expect(Date.parse(next.computedAt)).toBeGreaterThanOrEqual(T0 + 30_000);
    expect(stored('a')?.value).toEqual({ key: 'a', n: 1 });
  });

  it('computes a watched view at its active period and an unwatched one at its idle period', async () => {
    const v = view('a', LIGHT);
    scheduler.register(v.def);
    scheduler.start();
    await seconds(2);
    // Kept warm: computed once at the start, nobody having asked.
    expect(v.compute).toHaveBeenCalledTimes(1);

    // Nobody asks for 30 minutes: every 10 minutes.
    await seconds(1800);
    expect(v.compute).toHaveBeenCalledTimes(4);

    // Someone watches for 10 minutes (a request a minute): every minute.
    const before = v.compute.mock.calls.length;
    for (let minute = 0; minute < 10; minute++) {
      await scheduler.read(v.def);
      await seconds(60);
    }
    const watched = v.compute.mock.calls.length - before;
    expect(watched).toBeGreaterThanOrEqual(9);
    expect(watched).toBeLessThanOrEqual(11);

    // They leave: five minutes later it is back to the idle period.
    const after = v.compute.mock.calls.length;
    await seconds(300 + 1200);
    expect(v.compute.mock.calls.length - after).toBeLessThanOrEqual(7);
    expect(v.compute.mock.calls.length - after).toBeGreaterThanOrEqual(2);
  });

  it('computes a view that is not kept warm only while it is asked for', async () => {
    const v = view('variant', ON_DEMAND);
    scheduler.register(v.def);
    scheduler.start();
    await seconds(3600);
    expect(v.compute).not.toHaveBeenCalled();

    const first = scheduler.read(v.def);
    await seconds(1);
    expect((await first).data).toEqual({ key: 'variant', n: 1 });
    await seconds(3600);
    // Asked once: computed for the five minutes it counted as watched, then left alone.
    expect(v.compute.mock.calls.length).toBeLessThanOrEqual(6);
    const settled = v.compute.mock.calls.length;
    await seconds(3600);
    expect(v.compute).toHaveBeenCalledTimes(settled);
  });

  it('makes a request wait for the first value of a view, and tells it to come back when that takes too long', async () => {
    const v = view('cold', LIGHT, 'manual');
    scheduler.start();

    const quick = scheduler.read(v.def);
    await seconds(2);
    expect(v.compute).toHaveBeenCalledTimes(1);
    v.pending[0].resolve({ first: true });
    await seconds(0);
    expect((await quick).data).toEqual({ first: true });

    // A second view whose first computation takes 30 s: the request gives up at 20 s, the value still lands.
    const slow = view('slow', LIGHT, 'manual');
    const waiting = scheduler.read(slow.def).then(
      () => 'value',
      (e: Error) => e
    );
    await seconds(21);
    const refused = await waiting;
    expect(refused).toBeInstanceOf(ViewWarmingError);
    expect((refused as ViewWarmingError).retryAfterS).toBe(5);
    expect(slow.compute).toHaveBeenCalledTimes(1);
    slow.pending[0].resolve({ late: true });
    await seconds(0);
    expect((await scheduler.read(slow.def)).data).toEqual({ late: true });
  });

  it('runs two views at a time, one heavy at most, the most overdue first', async () => {
    const heavyA = view('heavy-a', HEAVY, 'manual');
    const heavyB = view('heavy-b', HEAVY, 'manual');
    const lights = [view('light-1', LIGHT, 'manual'), view('light-2', LIGHT, 'manual'), view('light-3', LIGHT, 'manual')];
    for (const v of [heavyA, heavyB, ...lights]) scheduler.register(v.def);
    scheduler.start();
    await seconds(2);

    const running = (): string[] => scheduler.describe().filter((d) => d.running).map((d) => String(d.view));
    // All are due (no value yet): light views first, they free their slot sooner.
    expect(running()).toEqual(['light-1', 'light-2']);
    lights[0].pending[0].resolve(1);
    await seconds(0);
    expect(running()).toEqual(['light-2', 'light-3']);
    lights[1].pending[0].resolve(1);
    await seconds(0);
    // One heavy view takes a slot; the other heavy one waits even though a slot... is taken by a light.
    expect(running()).toEqual(['heavy-a', 'light-3']);
    lights[2].pending[0].resolve(1);
    await seconds(1);
    // A slot is free and heavy-b is due, but a heavy view is already running.
    expect(running()).toEqual(['heavy-a']);
    heavyA.pending[0].resolve(1);
    await seconds(0);
    expect(running()).toEqual(['heavy-b']);
    heavyB.pending[0].resolve(1);
    await seconds(0);
    expect(running()).toEqual([]);
  });

  it('keeps serving the last value when a computation fails, and retries later, further apart', async () => {
    const v = view('a', LIGHT, 'manual');
    mockRedis.store.set('a:swr', JSON.stringify({ at: T0 - 700_000, value: { last: 'good' } }));
    scheduler.register(v.def);
    scheduler.start();
    await seconds(2);
    expect(v.compute).toHaveBeenCalledTimes(1);
    v.pending[0].reject(new RangeError('statement timeout'));
    await seconds(0);

    expect((await scheduler.read(v.def)).data).toEqual({ last: 'good' });
    expect(scheduler.describe()[0]).toMatchObject({ view: 'a', lastError: 'RangeError', running: false });
    expect(mockLog.warn).toHaveBeenCalledWith('View scheduler: computation failed', expect.objectContaining({ view: 'a', failures: 1 }));

    // Not again within 15 s, then again; a second failure doubles the wait.
    await seconds(14);
    expect(v.compute).toHaveBeenCalledTimes(1);
    await seconds(2);
    expect(v.compute).toHaveBeenCalledTimes(2);
    v.pending[1].reject(new Error('again'));
    await seconds(29);
    expect(v.compute).toHaveBeenCalledTimes(2);
    await seconds(2);
    expect(v.compute).toHaveBeenCalledTimes(3);
    v.pending[2].resolve({ back: true });
    await seconds(0);
    expect((await scheduler.read(v.def)).data).toEqual({ back: true });
    expect(scheduler.describe()[0]).toMatchObject({ lastError: null });
  });

  it('computes and serves the views from memory when Redis is down', async () => {
    mockRedis.healthy = false;
    const v = view('a', LIGHT);
    scheduler.start();
    const first = scheduler.read(v.def);
    await seconds(2);
    expect((await first).data).toEqual({ key: 'a', n: 1 });
    expect(mockRedis.store.size).toBe(0);
    // Watched: computed again each minute, still without Redis.
    await seconds(90);
    expect((await scheduler.read(v.def)).data).toEqual({ key: 'a', n: 2 });
    expect(mockRedis.store.size).toBe(0);
  });

  it('does not take a failed look at the store for "never computed": it looks again and finds the value', async () => {
    const v = view('a', HEAVY, 'manual');
    mockRedis.store.set('a:swr', JSON.stringify({ at: T0 - 60_000, value: { stored: true } }));
    mockRedis.failGet = true;
    scheduler.register(v.def);
    scheduler.start();
    await seconds(3);
    // One failed look: nothing is computed on the strength of it.
    expect(v.compute).not.toHaveBeenCalled();
    mockRedis.failGet = false;
    await seconds(6);
    expect((await scheduler.read(v.def)).data).toEqual({ stored: true });
    expect(v.compute).not.toHaveBeenCalled();
  });

  it('computes a view without the store once two looks at it have failed', async () => {
    const v = view('a', LIGHT);
    mockRedis.failGet = true;
    scheduler.register(v.def);
    scheduler.start();
    await seconds(12);
    expect(v.compute).toHaveBeenCalled();
    expect((await scheduler.read(v.def)).data).toMatchObject({ key: 'a' });
  });

  it('computes without the lock when the lock cannot be taken at all', async () => {
    const v = view('a', LIGHT);
    // Redis answers reads and refuses writes (out of memory with no eviction, a failover).
    mockRedis.failSet = true;
    scheduler.register(v.def);
    scheduler.start();
    await seconds(3);
    expect(v.compute).toHaveBeenCalledTimes(1);
  });

  it('leaves a view another instance is computing to that instance, and takes its value', async () => {
    const v = view('a', LIGHT);
    mockRedis.store.set('a:swr', JSON.stringify({ at: T0 - 700_000, value: { old: true } }));
    // The other instance holds the view's lock.
    mockRedis.store.set('lock:a:swr', 'someone-else');
    scheduler.register(v.def);
    scheduler.start();
    await seconds(20);
    expect(v.compute).not.toHaveBeenCalled();
    expect(mockRedis.store.get('lock:a:swr')).toBe('someone-else');

    // It finishes: its value is stored and its lock released.
    mockRedis.store.set('a:swr', JSON.stringify({ at: Date.now(), value: { from: 'other' } }));
    mockRedis.store.delete('lock:a:swr');
    await seconds(6);
    expect((await scheduler.read(v.def)).data).toEqual({ from: 'other' });
    expect(v.compute).not.toHaveBeenCalled();
  });

  it('releases its lock when a computation ends, whatever the outcome', async () => {
    const ok = view('ok', LIGHT);
    const bad = view('bad', LIGHT, 'manual');
    scheduler.register(ok.def);
    scheduler.register(bad.def);
    scheduler.start();
    await seconds(2);
    expect(mockRedis.store.has('lock:bad:swr')).toBe(true);
    bad.pending[0].reject(new Error('boom'));
    await seconds(0);
    expect([...mockRedis.store.keys()].filter((k) => k.startsWith('lock:'))).toEqual([]);
  });

  it('computes a view read from inside another one on the spot when it has no value, without a slot', async () => {
    const inner = view('inner', HEAVY);
    const outer = {
      key: 'outer',
      cadence: HEAVY,
      compute: jest.fn(async () => ({ inner: await scheduler.readOrCompute(inner.def) })),
    };
    scheduler.register(outer);
    scheduler.start();
    await seconds(2);
    // Both are heavy and only one heavy view runs at a time: waiting for the scheduler here would never end.
    expect((await scheduler.read(outer)).data).toEqual({ inner: { key: 'inner', n: 1 } });
    expect(stored('inner')?.value).toEqual({ key: 'inner', n: 1 });
    // The stored value is reused the next time.
    expect(await scheduler.readOrCompute(inner.def)).toEqual({ key: 'inner', n: 1 });
    expect(inner.compute).toHaveBeenCalledTimes(1);
  });

  it('follows the visitors of another view when told to: watch marks it asked for without reading it', async () => {
    const inner = view('inner', { activeS: 600, idleS: 3600, heavy: true });
    scheduler.register(inner.def);
    scheduler.start();
    await seconds(2);
    expect(inner.compute).toHaveBeenCalledTimes(1);
    // Unwatched: once an hour. Watched every minute for half an hour: every 10 minutes.
    for (let minute = 0; minute < 30; minute++) {
      scheduler.watch(inner.def);
      await seconds(60);
    }
    expect(inner.compute.mock.calls.length).toBe(4);
  });

  it('computes nothing before it is started, and nothing after it is stopped', async () => {
    const v = view('a', LIGHT);
    scheduler.register(v.def);
    await seconds(3600);
    expect(v.compute).not.toHaveBeenCalled();
    scheduler.start();
    await seconds(2);
    expect(v.compute).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await seconds(3600);
    expect(v.compute).toHaveBeenCalledTimes(1);
  });

  it('gives a slot back when a computation passes its deadline, and still keeps its value if it ever ends', async () => {
    const hung = view('hung', LIGHT, 'manual');
    const other = view('other', LIGHT, 'manual');
    const third = view('third', LIGHT);
    scheduler.register(hung.def);
    scheduler.register(other.def);
    scheduler.start();
    await seconds(2);
    // Both slots are taken by computations that do not answer.
    expect(scheduler.describe().filter((d) => d.running)).toHaveLength(2);
    scheduler.register(third.def);
    await seconds(170);
    expect(third.compute).not.toHaveBeenCalled();

    // Past three minutes the light views give their slots back: the third one runs.
    await seconds(15);
    expect(third.compute).toHaveBeenCalled();
    expect(scheduler.describe().find((d) => d.view === 'hung')).toMatchObject({ running: false, lastError: 'ViewDeadlineError' });
    expect(mockLog.warn).toHaveBeenCalledWith('View scheduler: computation failed', expect.objectContaining({ view: 'hung', errorType: 'ViewDeadlineError' }));
    expect([...mockRedis.store.keys()].filter((k) => k === 'lock:hung:swr' || k === 'lock:other:swr')).toEqual([]);

    // The first computation of 'hung' ends after all: its value is kept.
    hung.pending[0].resolve({ late: true });
    await seconds(0);
    expect((await scheduler.read(hung.def)).data).toEqual({ late: true });
    expect(new ViewDeadlineError().name).toBe('ViewDeadlineError');
  });

  it('pauses after a computation as long as it took: a view slower than its period does not run back to back', async () => {
    const slow = view('slow', LIGHT, 'manual');
    scheduler.register(slow.def);
    scheduler.start();
    await seconds(1);
    expect(slow.compute).toHaveBeenCalledTimes(1);
    // 90 s to compute a view due every 60 s (watched): already overdue when it ends.
    await seconds(89);
    scheduler.watch(slow.def);
    slow.pending[0].resolve({ n: 1 });
    await seconds(0);
    // Not at once, and not within the next 59 s: the pause is its period at most.
    await seconds(58);
    expect(slow.compute).toHaveBeenCalledTimes(1);
    await seconds(3);
    expect(slow.compute).toHaveBeenCalledTimes(2);
  });

  it('never lets the views computed only while asked delay the ones kept warm', async () => {
    const warm = view('warm', HEAVY, 'manual');
    const variants = [view('variant-1', { activeS: 300, idleS: 0, heavy: true }, 'manual'), view('variant-2', { activeS: 300, idleS: 0, heavy: true }, 'manual')];
    // All three have a value, all three are overdue, the variants far more than the warm one.
    mockRedis.store.set('warm:swr', JSON.stringify({ at: T0 - 2_000_000, value: 'w' }));
    for (const v of variants) mockRedis.store.set(`${v.def.key}:swr`, JSON.stringify({ at: T0 - 20_000_000, value: 'v' }));
    scheduler.register(warm.def);
    for (const v of variants) await scheduler.read(v.def);
    scheduler.start();
    await seconds(6);
    expect(scheduler.describe().filter((d) => d.running).map((d) => d.view)).toEqual(['warm']);
    warm.pending[0].resolve('w2');
    await seconds(1);
    // The warm view is up to date: now the variants, one heavy view at a time.
    expect(scheduler.describe().filter((d) => d.running).map((d) => d.view)).toEqual(['variant-1']);
  });

  it('computes at once a view someone is waiting for with nothing to show, a heavy one running or not', async () => {
    const running = view('heavy-running', HEAVY, 'manual');
    scheduler.register(running.def);
    scheduler.start();
    await seconds(2);
    expect(scheduler.describe().find((d) => d.view === 'heavy-running')).toMatchObject({ running: true });

    const cold = view('heavy-cold', { activeS: 300, idleS: 0, heavy: true });
    const first = scheduler.read(cold.def);
    await seconds(1);
    expect((await first).data).toEqual({ key: 'heavy-cold', n: 1 });
  });

  it('says at once that a view without a value just failed, instead of making each request wait', async () => {
    const v = view('broken', LIGHT, 'manual');
    scheduler.start();
    const first = scheduler.read(v.def).then(
      () => 'value',
      (e: Error) => e
    );
    await seconds(2);
    v.pending[0].reject(new Error('relation does not exist'));
    await seconds(0);
    expect(await first).toBeInstanceOf(ViewWarmingError);

    // The retry is 15 s away: the next request is told so, without waiting 20 s for nothing.
    const started = Date.now();
    const refused = await scheduler.read(v.def).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(ViewWarmingError);
    expect((refused as ViewWarmingError).retryAfterS).toBeGreaterThanOrEqual(10);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('computes a view kept only while asked again before serving it, once it is older than its kept copy', async () => {
    const v = view('variant', ON_DEMAND);
    scheduler.start();
    const first = scheduler.read(v.def);
    await seconds(1);
    expect((await first).data).toEqual({ key: 'variant', n: 1 });
    // Left alone for 7 hours: the stored copy is gone (6 h), and so is the one held here.
    await seconds(7 * 3600);
    mockRedis.store.delete('variant:swr');
    const calls = v.compute.mock.calls.length;
    const later = scheduler.read(v.def);
    await seconds(1);
    const value = await later;
    expect(v.compute.mock.calls.length).toBe(calls + 1);
    expect(Date.now() - Date.parse(value.computedAt)).toBeLessThan(5_000);
  });

  it('computes a cheap view on the spot for the request that finds it without a value, started or not', async () => {
    const status = view('status', { activeS: 15, idleS: 60, cheap: true });
    // Not started: the first seconds of a process.
    const results = await Promise.all([scheduler.read(status.def), scheduler.read(status.def), scheduler.read(status.def)]);
    expect(results.map((r) => r.data)).toEqual([{ key: 'status', n: 1 }, { key: 'status', n: 1 }, { key: 'status', n: 1 }]);
    expect(status.compute).toHaveBeenCalledTimes(1);
    expect(stored('status')?.value).toEqual({ key: 'status', n: 1 });
  });
});
