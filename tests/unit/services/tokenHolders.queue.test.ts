/**
 * Hypurrscan holder lists are downloaded one at a time, and the queue is
 * bounded so a client cycling through tokens can't pile downloads up:
 * - past 12 waiting regular downloads a new one is refused before any request;
 * - a token view waits up to 20 s for room for both its lists, then is refused;
 * - a download that waited over 30 s, or whose token view was evicted, is
 *   dropped when its turn comes;
 * - the stakedHYPE table's download goes ahead of the token views' ones;
 * - a token view whose lists land after its eviction is not held;
 * - built views are kept in Redis: a restart (or eviction) serves the last
 *   view at once instead of downloading again.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisData = new Map<string, string>();
jest.mock('../../../src/core/redis.service', () => ({
  // No spot markets cached: token names are only shape-checked (fail open).
  redisService: {
    get: jest.fn(async (key: string) => redisData.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      redisData.set(key, value);
    }),
  },
}));

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const holders = (token: string): unknown => ({
  token,
  lastUpdate: 1_791_297_085,
  holders: { '0xaaa': 10, '0xbbb': 5 },
  holdersCount: 2,
});

/** Marks a promise expected to reject as handled before the assertion awaits it. */
const handled = <T>(promise: Promise<T>): Promise<T> => {
  promise.catch(() => undefined);
  return promise;
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
};

/** Every request waits until released, in order. */
function gatedFetch() {
  const paths: string[] = [];
  const gates: Array<() => void> = [];
  const mock = jest.fn((url: string) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    return new Promise<Response>((resolve) => {
      gates.push(() => resolve(json(holders(path.split('/').pop() ?? ''))));
    });
  });
  /** Releases the running request and lets the next one start. */
  const releaseNext = async (): Promise<void> => {
    await settle();
    const gate = gates.shift();
    if (!gate) throw new Error('No request in flight');
    gate();
    await settle();
  };
  return { mock, paths, releaseNext };
}

describe('HypurrscanTokenHoldersClient queue', () => {
  const realFetch = global.fetch;
  let now: number;
  let gated: ReturnType<typeof gatedFetch>;
  let clientMod: typeof import('../../../src/clients/hypurrscan/tokenHolders.client');

  beforeEach(() => {
    jest.resetModules();
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    gated = gatedFetch();
    global.fetch = gated.mock as unknown as typeof fetch;
    clientMod = require('../../../src/clients/hypurrscan/tokenHolders.client');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('refuses a regular download past 12 waiting ones, without a request', async () => {
    const client = clientMod.HypurrscanTokenHoldersClient.getInstance();
    const accepted = Array.from({ length: 13 }, (_, i) => client.getHolders(`T${i}`));
    await settle();
    // One running, twelve waiting.
    expect(gated.mock).toHaveBeenCalledTimes(1);
    expect(client.freeSlots()).toBe(0);

    await expect(client.getHolders('T13')).rejects.toBeInstanceOf(clientMod.HoldersQueueError);
    // The stakedHYPE table is never refused.
    const priority = client.getStakedHolders('HYPE', { priority: true });

    for (let i = 0; i < 14; i++) await gated.releaseNext();
    await expect(Promise.all(accepted)).resolves.toHaveLength(13);
    await expect(priority).resolves.toBeDefined();
    expect(gated.mock).toHaveBeenCalledTimes(14);
  });

  it('runs the priority download right after the running one', async () => {
    const client = clientMod.HypurrscanTokenHoldersClient.getInstance();
    const regular = [client.getHolders('A'), client.getHolders('B'), client.getHolders('C')];
    await settle();
    const staked = client.getStakedHolders('HYPE', { priority: true });

    for (let i = 0; i < 4; i++) await gated.releaseNext();
    await Promise.all([...regular, staked]);
    expect(gated.paths).toEqual(['/holders/A', '/holders/stakedHYPE', '/holders/B', '/holders/C']);
  });

  it('drops a download that waited over 30 s, and one nobody wants any more', async () => {
    const client = clientMod.HypurrscanTokenHoldersClient.getInstance();
    const first = client.getHolders('A');
    const late = handled(client.getHolders('B'));
    const alsoLate = handled(client.getHolders('C', { stillWanted: () => true }));
    await settle();

    now += 31_000;
    await gated.releaseNext();
    await expect(first).resolves.toBeDefined();
    await expect(late).rejects.toThrow('waited too long');
    await expect(alsoLate).rejects.toThrow('waited too long');
    expect(gated.paths).toEqual(['/holders/A']);

    const fresh = client.getHolders('E', { stillWanted: () => false });
    await expect(fresh).rejects.toThrow('no longer wanted');
    expect(gated.paths).toEqual(['/holders/A']);
  });
});

describe('TokenHoldersService under a token rotation', () => {
  const realFetch = global.fetch;
  let gated: ReturnType<typeof gatedFetch>;
  let service: import('../../../src/services/spot/tokenHolders.service').TokenHoldersService;
  let mod: typeof import('../../../src/services/spot/tokenHolders.service');

  beforeEach(() => {
    // Date advances with the fake clock: the 20 s queue wait is measured with it.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.resetModules();
    redisData.clear();
    gated = gatedFetch();
    global.fetch = gated.mock as unknown as typeof fetch;
    mod = require('../../../src/services/spot/tokenHolders.service');
    service = mod.TokenHoldersService.getInstance();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('waits for room in a full queue, and answers "unavailable" only after 20 s', async () => {
    const pages = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'].map((t) => handled(service.getHoldersPage(t, 1, 10)));
    await settle();
    // T1's spot list runs; T1's staked list and T2-T6 wait (11): T7 and T8 wait for two slots.
    expect(gated.mock).toHaveBeenCalledTimes(1);

    // Two lists done: T7 gets its slots, T8 keeps waiting.
    await gated.releaseNext();
    await gated.releaseNext();
    await expect(pages[0]).resolves.toMatchObject({ token: 'T1' });

    jest.advanceTimersByTime(20_001);
    await settle();
    await expect(pages[7]).rejects.toBeInstanceOf(mod.HoldersUnavailableError);

    for (let i = 0; i < 12; i++) await gated.releaseNext();
    await expect(Promise.all(pages.slice(0, 7))).resolves.toHaveLength(7);
    expect(gated.mock).toHaveBeenCalledTimes(14);
  });

  it('skips the queued downloads of evicted views', async () => {
    const first = ['T0', 'T1', 'T2'].map((t) => handled(service.getHoldersPage(t, 1, 10)));
    await settle();
    // T0's spot list runs, five lists wait. 24 more tokens read evict T0, T1
    // and T2 (24 views held at most); past the queue's room they wait.
    const rest = Array.from({ length: 24 }, (_, i) => handled(service.getHoldersPage(`T${i + 3}`, 1, 10)));
    await settle();

    await gated.releaseNext();
    for (const page of first) await expect(page).rejects.toBeInstanceOf(mod.HoldersUnavailableError);
    // T0's queued staked list and T1's and T2's lists never reached Hypurrscan.
    await gated.releaseNext();
    expect(gated.paths.slice(0, 2)).toEqual(['/holders/T0', '/holders/T3']);

    jest.advanceTimersByTime(20_001);
    for (let i = 0; i < 20; i++) await gated.releaseNext().catch(() => undefined);
    await Promise.allSettled(rest);
  });

  it('keeps built views in Redis: a restart serves the last one without downloading again', async () => {
    jest.useRealTimers();
    const page = service.getHoldersPage('HYPE', 1, 10);
    await gated.releaseNext();
    await gated.releaseNext();
    await expect(page).resolves.toMatchObject({ token: 'HYPE', holdersCount: 2 });
    // The view is gzipped off the event loop before it is stored.
    for (let i = 0; i < 50 && !redisData.has('spot:holders:view:HYPE'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(redisData.has('spot:holders:view:HYPE')).toBe(true);

    jest.resetModules();
    mod = require('../../../src/services/spot/tokenHolders.service');
    const restarted = mod.TokenHoldersService.getInstance();
    await expect(restarted.getHoldersPage('HYPE', 1, 10)).resolves.toMatchObject({ token: 'HYPE', holdersCount: 2 });
    // Served from Redis: no new download.
    expect(gated.paths).toEqual(['/holders/HYPE', '/holders/stakedHYPE']);
  });
});
