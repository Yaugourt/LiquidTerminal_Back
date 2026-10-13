/**
 * The Assistance Fund's buybacks come from its fills (`userFillsByTime`), read
 * by the backend instead of every browser:
 * - a completed day is read whole, past the 2,000 fills of one response, and
 *   kept only if Hyperliquid still held all of it (its horizon, read after the
 *   day, is no later than the day's start) — a day past the horizon is left
 *   out, never served as zero;
 * - completed days are read in the background, newest first, paced to 60
 *   weight a minute, and kept in Redis so a restart doesn't read them again;
 * - the running day is read incrementally, at most once a minute, and starts
 *   over at UTC midnight;
 * - kept days unreadable at boot (Redis down) are read again by a later
 *   request, and a save never replaces them while Redis can't be read.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisStore = new Map<string, string>();

const redisSet = jest.fn(async (key: string, value: string) => {
  redisStore.set(key, value);
});
/** Redis unreadable: get answers null (as for a missing key), mget null overall. */
let redisDown = false;
const redisGet = jest.fn(async (key: string) => (redisDown ? null : redisStore.get(key) ?? null));
const redisMget = jest.fn(async (keys: string[]) => (redisDown ? null : keys.map((k) => redisStore.get(k) ?? null)));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: (key: string) => redisGet(key),
    mget: (keys: string[]) => redisMget(keys),
    set: (key: string, value: string) => redisSet(key, value),
  },
}));

const AF = '0xfefefefefefefefefefefefefefefefefefefefe';
const DAY = 86_400_000;
const MIN = 60_000;
const at = (iso: string): number => Date.parse(iso);
const TODAY = at('2026-10-08T00:00:00Z');
/** Oldest fill Hyperliquid serves: 2026-09-26 is partly gone, 2026-09-25 entirely. */
const HORIZON = at('2026-09-26T17:49:00Z');

interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  tid: number;
  /** Test only: served this long after its time (indexing lag). */
  lagMs?: number;
}

let tid = 1;
const fill = (time: number, sz: number, px: number, extra: Partial<Fill> = {}): Fill => ({
  coin: '@107',
  px: String(px),
  sz: String(sz),
  side: 'B',
  time,
  tid: tid++,
  ...extra,
});

/** `n` buys spread over [start, start + span), plus a sell and a BTC fill that must be ignored. */
const dayFills = (start: number, n: number, span = DAY - 1_000): Fill[] => {
  const out: Fill[] = [];
  for (let i = 0; i < n; i++) {
    out.push(fill(start + Math.floor((i * span) / n), 10 + (i % 7), 80 + (i % 11) / 10));
  }
  out.push(fill(start + 1_000, 99, 85, { side: 'A' }));
  out.push(fill(start + 2_000, 99, 85, { coin: 'BTC' }));
  return out;
};

let fills: Fill[] = [];
let horizon = HORIZON;
/** Calls answered with this status (null → served). */
let failWith: ((body: { startTime: number; endTime: number }) => number | null) | null = null;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Time and Hyperliquid weight (20 + 1 per 20 fills) of each served read. */
let served: { time: number; weight: number }[] = [];

/** Hyperliquid `userFillsByTime`: oldest first, from the horizon on, 2,000 per response. */
const fakeHyperliquid = jest.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const status = failWith?.(body) ?? null;
  if (status) return json({ error: 'nope' }, status);
  const rows = fills
    .filter((f) => f.time >= Math.max(body.startTime, horizon) && f.time <= body.endTime)
    .filter((f) => Date.now() >= f.time + (f.lagMs ?? 0))
    .sort((a, b) => a.time - b.time || a.tid - b.tid)
    .slice(0, 2_000)
    .map(({ lagMs: _lagMs, ...f }) => f);
  served.push({ time: Date.now(), weight: 20 + Math.ceil(rows.length / 20) });
  return json(rows);
});

const bodies = (): { type: string; user: string; startTime: number; endTime: number }[] =>
  fakeHyperliquid.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));

const expected = (start: number, end = start + DAY): { hype: number; usd: number; fills: number } => {
  const buys = fills
    .filter((f) => f.time >= Math.max(start, horizon) && f.time < end && f.coin === '@107' && f.side === 'B')
    .sort((a, b) => a.time - b.time || a.tid - b.tid);
  return {
    hype: buys.reduce((s, f) => s + parseFloat(f.sz), 0),
    usd: buys.reduce((s, f) => s + parseFloat(f.sz) * parseFloat(f.px), 0),
    fills: buys.length,
  };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Lets the background reads run for `ms` of fake time. */
const run = async (ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await jest.advanceTimersByTimeAsync(Math.min(5_000, end - Date.now()));
    await flush();
  }
};

type Mod = typeof import('../../../src/services/revenue/afBuybacks.service');

describe('AfBuybacksService', () => {
  const realFetch = global.fetch;
  let mod: Mod;

  const load = (): Mod => {
    jest.isolateModules(() => {
      mod = require('../../../src/services/revenue/afBuybacks.service');
    });
    return mod;
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.setSystemTime(at('2026-10-08T15:00:00Z'));
    tid = 1;
    horizon = HORIZON;
    failWith = null;
    served = [];
    redisStore.clear();
    redisGet.mockClear();
    redisSet.mockClear();
    redisMget.mockClear();
    redisDown = false;
    fakeHyperliquid.mockClear();
    // 2026-09-25 … 2026-10-07: small days, one of 4,500 buys (three pages), and today so far.
    fills = [];
    for (let d = 13; d >= 1; d--) {
      const start = TODAY - d * DAY;
      fills.push(...dayFills(start, start === at('2026-10-04T00:00:00Z') ? 4_500 : 40));
    }
    fills.push(...dayFills(TODAY, 30, 15 * 60 * MIN - 60_000));
    global.fetch = fakeHyperliquid as unknown as typeof fetch;
    load();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('serves the running day from midnight and its 12 latest buys without waiting for completed days', async () => {
    const snap = await mod.AfBuybacksService.getInstance().getBuybacks();

    expect(snap.today).toEqual({ time: TODAY, ...expected(TODAY) });
    expect(snap.today.fills).toBe(30);
    const todayBuys = fills.filter((f) => f.time >= TODAY && f.coin === '@107' && f.side === 'B');
    expect(snap.recent).toEqual(
      todayBuys.slice(-12).reverse().map((f) => ({ time: f.time, px: parseFloat(f.px), sz: parseFloat(f.sz) }))
    );
    expect(snap.days).toEqual([]);
    expect(snap.windowDays).toBe(13);
    expect(snap.lastUpdate).toBe(Date.now());
    expect(bodies()).toEqual([{ type: 'userFillsByTime', user: AF, startTime: TODAY, endTime: Date.now() }]);
  });

  it('reads completed days whole in the background and leaves out the days past the horizon', async () => {
    const service = mod.AfBuybacksService.getInstance();
    await service.getBuybacks();
    await run(30 * MIN);

    const snap = await service.getBuybacks();
    const kept = Array.from({ length: 11 }, (_, i) => TODAY - (11 - i) * DAY); // 2026-09-27 … 2026-10-07
    expect(snap.days.map((d) => d.time)).toEqual(kept);
    for (const day of snap.days) {
      const want = expected(day.time);
      expect(day.fills).toBe(want.fills);
      expect(day.hype).toBeCloseTo(want.hype, 6);
      expect(day.usd).toBeCloseTo(want.usd, 4);
    }
    // 4,500 buys on 2026-10-04: every page read, none counted twice
    expect(snap.days.find((d) => d.time === at('2026-10-04T00:00:00Z'))?.fills).toBe(4_500);
    expect(snap.days.some((d) => d.time < at('2026-09-27T00:00:00Z'))).toBe(false);

    // newest first, after the running day: 2026-10-07 is the first completed day read
    const dayReads = bodies().filter((b) => b.startTime > 0 && b.startTime < TODAY);
    expect(dayReads[0].startTime).toBe(TODAY - DAY);
    expect(dayReads[0].endTime).toBe(TODAY - 1);

    // and a day past the horizon is not read again
    const before = fakeHyperliquid.mock.calls.length;
    await run(30 * MIN);
    await service.getBuybacks();
    await run(10 * MIN);
    expect(
      bodies().slice(before).filter((b) => b.startTime > 0 && b.startTime < TODAY)
    ).toEqual([]);
  });

  it('paces the background reads to 60 weight a minute', async () => {
    const service = mod.AfBuybacksService.getInstance();
    await service.getBuybacks();
    await run(60 * MIN);

    expect(served.length).toBeGreaterThan(10);
    // every read waits for the weight booked before it
    for (let i = 1; i < served.length; i++) {
      const owed = (served[i - 1].weight / 60) * MIN;
      expect(served[i].time - served[i - 1].time).toBeGreaterThanOrEqual(owed - 1);
    }
    const total = served.reduce((sum, r) => sum + r.weight, 0);
    const span = served[served.length - 1].time - served[0].time;
    expect(total - served[served.length - 1].weight).toBeLessThanOrEqual((span / MIN) * 60 + 1);
  });

  it('keeps the days it read in Redis: a restarted service serves them without reading them again', async () => {
    await mod.AfBuybacksService.getInstance().getBuybacks();
    await run(30 * MIN);
    const stored = JSON.parse(redisStore.get('hype:af-buybacks:days:v1') ?? '{}');
    expect(Object.keys(stored)).toHaveLength(11);

    load();
    fakeHyperliquid.mockClear();
    const snap = await mod.AfBuybacksService.getInstance().getBuybacks();
    expect(snap.days).toHaveLength(11);
    expect(snap.days[0]).toEqual({ time: TODAY - 11 * DAY, ...stored[String(TODAY - 11 * DAY)] });
    await run(30 * MIN);
    // only the two days past the horizon are tried again (one batch, one horizon read)
    const completedReads = bodies().filter((b) => b.startTime > 0 && b.startTime < TODAY);
    expect(completedReads.map((b) => b.startTime)).toEqual([TODAY - 12 * DAY, TODAY - 13 * DAY]);
    expect(bodies().filter((b) => b.startTime === 0)).toHaveLength(2);
  });

  it('reads the kept days again once Redis is back, and saves nothing while it is down', async () => {
    await mod.AfBuybacksService.getInstance().getBuybacks();
    await run(30 * MIN);
    const stored = redisStore.get('hype:af-buybacks:days:v1');
    expect(Object.keys(JSON.parse(stored ?? '{}'))).toHaveLength(11);

    // A restart while Redis is unreadable: Hyperliquid's horizon has moved
    // (2 days left), the older kept days can only come from Redis.
    horizon = TODAY - 2 * DAY;
    redisDown = true;
    load();
    redisSet.mockClear();
    const service = mod.AfBuybacksService.getInstance();
    const during = await service.getBuybacks();
    expect(during.days).toEqual([]);
    await run(30 * MIN);
    expect(redisSet).not.toHaveBeenCalled();
    expect(redisStore.get('hype:af-buybacks:days:v1')).toBe(stored);

    redisDown = false;
    const after = await service.getBuybacks();
    expect(after.days).toHaveLength(11);
    expect(after.days[0].time).toBe(TODAY - 11 * DAY);
  });

  it('answers the first request after midnight while a refresh started before it is still running', async () => {
    jest.setSystemTime(at('2026-10-08T23:58:00Z'));
    const service = mod.AfBuybacksService.getInstance();
    await service.getBuybacks();

    // Running-day reads made before midnight hang until released.
    const real = fakeHyperliquid.getMockImplementation();
    if (!real) throw new Error('fake Hyperliquid has no implementation');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeHyperliquid.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.startTime >= TODAY && Date.now() < TODAY + DAY) await gate;
      return real(url, init);
    });
    try {
      await jest.advanceTimersByTimeAsync(90_000); // 23:59:30: stale, one refresh starts and hangs
      expect((await service.getBuybacks()).today.time).toBe(TODAY);
      await jest.advanceTimersByTimeAsync(40_000); // 00:00:10

      const afterMidnight = await service.getBuybacks();
      expect(afterMidnight.today.time).toBe(TODAY + DAY);

      // The pre-midnight refresh lands late and is not kept.
      release();
      await flush();
      expect((await service.getBuybacks()).today.time).toBe(TODAY + DAY);
    } finally {
      release();
      fakeHyperliquid.mockImplementation(real);
    }
  });

  it('reads the running day incrementally, at most once a minute', async () => {
    const t0 = Date.now();
    const service = mod.AfBuybacksService.getInstance();
    const first = await service.getBuybacks();
    const lastFill = Math.max(...fills.filter((f) => f.time >= TODAY).map((f) => f.time));

    fills.push(fill(t0 + 10_000, 7, 90), fill(t0 + 20_000, 3, 91));
    await jest.advanceTimersByTimeAsync(30_000);
    expect((await service.getBuybacks()).today).toEqual(first.today);

    await jest.advanceTimersByTimeAsync(31_000);
    const callsBefore = fakeHyperliquid.mock.calls.length;
    // stale: served at once while one read runs
    expect((await service.getBuybacks()).today).toEqual(first.today);
    await flush();
    const reads = bodies().slice(callsBefore).filter((b) => b.startTime >= TODAY);
    expect(reads).toEqual([{ type: 'userFillsByTime', user: AF, startTime: lastFill - 30_000, endTime: t0 + 61_000 }]);

    const next = await service.getBuybacks();
    expect(next.today).toEqual({ time: TODAY, ...expected(TODAY) });
    expect(next.today.fills).toBe(32);
    expect(next.recent.slice(0, 2)).toEqual([
      { time: t0 + 20_000, px: 91, sz: 3 },
      { time: t0 + 10_000, px: 90, sz: 7 },
    ]);
    expect(next.recent).toHaveLength(12);
    expect(next.lastUpdate).toBe(t0 + 61_000);
  });

  it('starts a new running day at midnight and reads the finished one once it has settled', async () => {
    fills.push(
      fill(at('2026-10-08T23:58:00Z'), 5, 90),
      // indexed late: a day read before it has settled would miss it for good
      fill(at('2026-10-08T23:59:50Z'), 4, 90, { lagMs: 55_000 }),
      fill(at('2026-10-09T00:00:20Z'), 2, 92)
    );
    jest.setSystemTime(at('2026-10-08T23:20:00Z'));
    const service = mod.AfBuybacksService.getInstance();
    await service.getBuybacks();
    await run(30 * MIN); // the window's completed days are read meanwhile
    await run(9 * MIN + 40_000); // 23:59:40
    expect((await service.getBuybacks()).today.time).toBe(TODAY);
    await run(50_000); // 2026-10-09 00:00:30: the 23:59:40 read is still fresh

    const afterMidnight = await service.getBuybacks();
    expect(afterMidnight.today).toEqual({ time: TODAY + DAY, hype: 2, usd: 184, fills: 1 });
    expect(afterMidnight.days.at(-1)?.time).toBe(TODAY - DAY); // 2026-10-08 is not settled yet
    expect(afterMidnight.days).toHaveLength(11);

    await run(MIN); // 00:01:30
    await service.getBuybacks();
    await run(5 * MIN);
    const settled = await service.getBuybacks();
    expect(settled.days).toHaveLength(12);
    const last = settled.days.at(-1);
    expect(last?.time).toBe(TODAY);
    expect(last?.fills).toBe(expected(TODAY).fills);
    expect(last?.fills).toBe(32);
    expect(last?.usd).toBeCloseTo(expected(TODAY).usd, 4);
  });

  it('fails when the running day was never read, and serves it stale for an hour', async () => {
    failWith = () => 500;
    const service = mod.AfBuybacksService.getInstance();
    await expect(service.getBuybacks()).rejects.toBeInstanceOf(mod.AfBuybacksUnavailableError);

    failWith = null;
    const ok = await service.getBuybacks();
    failWith = () => 500;
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect((await service.getBuybacks()).today).toEqual(ok.today);
    await jest.advanceTimersByTimeAsync(57 * MIN);
    expect((await service.getBuybacks()).today).toEqual(ok.today);
    await jest.advanceTimersByTimeAsync(2 * MIN);
    await expect(service.getBuybacks()).rejects.toBeInstanceOf(mod.AfBuybacksUnavailableError);
  });

  it('retries a failed background read after 5 minutes, not before', async () => {
    failWith = (body) => (body.startTime < TODAY ? 500 : null);
    const service = mod.AfBuybacksService.getInstance();
    await service.getBuybacks();
    await run(2 * MIN);
    const failed = bodies().filter((b) => b.startTime < TODAY).length;
    expect(failed).toBe(1);

    failWith = null;
    await run(2 * MIN);
    await service.getBuybacks();
    await run(MIN);
    expect(bodies().filter((b) => b.startTime < TODAY)).toHaveLength(failed);

    await run(2 * MIN);
    await service.getBuybacks();
    await run(30 * MIN);
    expect((await service.getBuybacks()).days).toHaveLength(11);
  });

  it('does not keep a day whose 2,000 fills of one millisecond cannot be paged through', async () => {
    const stuck = TODAY - DAY + 5_000;
    fills = fills.filter((f) => f.time < TODAY - DAY || f.time >= TODAY);
    for (let i = 0; i < 2_001; i++) fills.push(fill(stuck, 1, 90));
    const service = mod.AfBuybacksService.getInstance();
    await service.getBuybacks();
    // A full page weighs 120: the next one waits 2 minutes at 60 a minute.
    await run(3 * MIN);
    expect((await service.getBuybacks()).days.some((d) => d.time === TODAY - DAY)).toBe(false);
    // two pages, then it gives up (no re-reading of the same millisecond)
    expect(bodies().filter((b) => b.startTime >= TODAY - DAY && b.startTime < TODAY)).toHaveLength(2);
  });
});
