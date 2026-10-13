/**
 * Hypurrscan holder lists are downloaded one at a time, and the queue is
 * bounded so a client cycling through tokens can't pile downloads up:
 * - past 6 waiting regular downloads a new one is refused before any request;
 * - a download that waited over 30 s, or whose token view was evicted, is
 *   dropped when its turn comes;
 * - the stakedHYPE table's download goes ahead of the token views' ones;
 * - a token view whose lists land after its eviction is not held.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../src/core/redis.service', () => ({
  // No spot markets cached: token names are only shape-checked (fail open).
  redisService: { get: jest.fn(async () => null) },
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

  it('refuses a regular download past 6 waiting ones, without a request', async () => {
    const client = clientMod.HypurrscanTokenHoldersClient.getInstance();
    const accepted = Array.from({ length: 7 }, (_, i) => client.getHolders(`T${i}`));
    await settle();
    // One running, six waiting.
    expect(gated.mock).toHaveBeenCalledTimes(1);
    expect(client.freeSlots()).toBe(0);

    await expect(client.getHolders('T7')).rejects.toBeInstanceOf(clientMod.HoldersQueueError);
    // The stakedHYPE table is never refused.
    const priority = client.getStakedHolders('HYPE', { priority: true });

    for (let i = 0; i < 8; i++) await gated.releaseNext();
    await expect(Promise.all(accepted)).resolves.toHaveLength(7);
    await expect(priority).resolves.toBeDefined();
    expect(gated.mock).toHaveBeenCalledTimes(8);
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
    jest.resetModules();
    gated = gatedFetch();
    global.fetch = gated.mock as unknown as typeof fetch;
    mod = require('../../../src/services/spot/tokenHolders.service');
    service = mod.TokenHoldersService.getInstance();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('answers "unavailable" once the queue is full instead of queueing more downloads', async () => {
    const pages = ['T1', 'T2', 'T3', 'T4'].map((t) => handled(service.getHoldersPage(t, 1, 10)));
    await settle();
    // T1's spot list runs; T1's staked list, T2 and T3 wait (5): T4 needs two slots, one is left.
    await expect(pages[3]).rejects.toBeInstanceOf(mod.HoldersUnavailableError);

    for (let i = 0; i < 6; i++) await gated.releaseNext();
    await expect(Promise.all(pages.slice(0, 3))).resolves.toHaveLength(3);
    expect(gated.mock).toHaveBeenCalledTimes(6);
  });

  it('skips the queued downloads of evicted views', async () => {
    const first = ['T0', 'T1', 'T2'].map((t) => handled(service.getHoldersPage(t, 1, 10)));
    await settle();
    // T0's spot list runs, five lists wait. Eight more tokens read (each
    // refused: one slot left) evict T0, T1 and T2 (8 views held at most).
    for (let i = 3; i < 11; i++) {
      await expect(service.getHoldersPage(`T${i}`, 1, 10)).rejects.toBeInstanceOf(mod.HoldersUnavailableError);
    }

    await gated.releaseNext();
    for (const page of first) await expect(page).rejects.toBeInstanceOf(mod.HoldersUnavailableError);
    // Only T0's running download reached Hypurrscan.
    expect(gated.paths).toEqual(['/holders/T0']);
  });
});
