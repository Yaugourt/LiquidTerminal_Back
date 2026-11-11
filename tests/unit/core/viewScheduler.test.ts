/**
 * ViewScheduler: requests read the last value and never start a computation;
 * the scheduler computes each view at its own period, a bounded number at a
 * time; a failed or absent Redis does not stop the views from being served.
 */
const mockRedis = {
  healthy: true,
  store: new Map<string, string>(),
  failGet: false,
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
      set: async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
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

import { ViewScheduler, ViewWarmingError, type ViewCadence } from '../../../src/core/viewScheduler';

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

  it('survives a Redis read that fails: the view is looked for again, then computed', async () => {
    mockRedis.failGet = true;
    const v = view('a', LIGHT);
    scheduler.start();
    const first = scheduler.read(v.def).catch((e: Error) => e);
    await seconds(3);
    mockRedis.failGet = false;
    await seconds(10);
    expect(v.compute).toHaveBeenCalled();
    expect((await scheduler.read(v.def)).data).toMatchObject({ key: 'a' });
    await first;
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
});
