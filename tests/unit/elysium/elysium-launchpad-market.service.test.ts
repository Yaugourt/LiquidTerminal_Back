/**
 * ElysiumLaunchpadMarketService with the database replaced by a small in-memory
 * one (the SQL itself is checked against a real Postgres by
 * ~/lt-perf-tests/elysium-audit-2026-11-10/step2/equiv.ts): what a page is
 * assembled from, in which order, how the list is walked by offset, and how
 * the snapshot, the bounded caches and the per-client shares behave.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/core/redis.service', () => ({ redisService: { get: jest.fn().mockResolvedValue(null) } }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));

import {
  ElysiumLaunchpadMarketService,
  LaunchpadBusyError,
  LaunchpadSearchBusyError,
  launchTokenSorter,
  toLaunchTokenView,
  type ElysiumLaunchTokenView,
} from '../../../src/services/elysium/elysium-launchpad-market.service';
import { HYPE_QUOTES, USD_QUOTES } from '../../../src/services/elysium/elysium-launchpad.util';

const HYPE = HYPE_QUOTES[0];
const USDC = USD_QUOTES[0];
const HYPE_USD = 50;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');

interface Launch {
  token: string;
  launchpad: string;
  kind: string;
  quote: string;
  born: number;
  price: number | null;
  sold: string | null;
  /** Set for a token traded over the last 24h. */
  day?: { price_24h: number | null; vol24: string; txns24: number; traders24: number };
}

const token = (n: number): string => '0x' + n.toString(16).padStart(40, '0');
function launch(n: number, over: Partial<Launch> = {}): Launch {
  return { token: token(n), launchpad: 'CorePad', kind: 'curve', quote: HYPE, born: 1_790_000_000 - n * 1000, price: null, sold: null, ...over };
}
const sqlRow = (l: Launch) => ({
  token: l.token,
  launchpad: l.launchpad,
  kind: l.kind,
  creator: null,
  symbol: 'S' + Number.parseInt(l.token.slice(2), 16),
  name: 'n' + Number.parseInt(l.token.slice(2), 16),
  quote: l.quote,
  born: l.born,
  graduated: false,
  holders: 3,
  top10_pct: 1,
  dev_pct: 1,
  price: l.price,
  sold: l.sold,
});

/** Answers the service's statements from `launches`, by what each statement reads. */
function fakeDb(launches: Launch[]) {
  const calls: string[] = [];
  const timed = async (_ms: number, query: { sql: string; values: unknown[] }): Promise<unknown[]> => {
    const sql = query.sql.replace(/\s+/g, ' ');
    const values = query.values;
    const arrays = values.filter(Array.isArray) as string[][];
    const strings = values.filter((v): v is string => typeof v === 'string');
    const pad = strings.find((s) => launches.some((l) => l.launchpad === s) && sql.includes('l.launchpad ='));
    const inPad = (l: Launch) => !pad || l.launchpad === pad;
    const limit = [...values].reverse().find((v): v is number => typeof v === 'number');
    const newestFirst = (a: Launch, b: Launch) => b.born - a.born || (a.token < b.token ? -1 : 1);

    if (sql.includes('WITH day AS')) {
      calls.push('active');
      return launches.filter((l) => l.day).map((l) => ({ ...sqlRow(l), ...l.day }));
    }
    if (sql.includes('GROUP BY launchpad')) {
      calls.push('pads');
      const pads = [...new Set(launches.map((l) => l.launchpad))];
      return pads.map((p) => ({ launchpad: p, tokens: launches.filter((l) => l.launchpad === p).length, graduated: 0, launched24h: 0 }));
    }
    if (sql.includes('l.token = ANY')) {
      calls.push('hydrate');
      const wanted = new Set(arrays[0]);
      return launches.filter((l) => wanted.has(l.token)).map(sqlRow);
    }
    if (sql.includes('ILIKE')) {
      calls.push('search');
      const pattern = strings[0];
      const needle = pattern.slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase();
      return launches
        .filter((l) => inPad(l) && (sqlRow(l).symbol.toLowerCase().includes(needle) || l.token.includes(needle)))
        .sort(newestFirst)
        .slice(0, limit)
        .map((l) => ({ token: l.token, last_price: l.price, quote: l.quote, launchpad: l.launchpad, born: l.born }));
    }
    if (sql.includes('UNION ALL') || sql.includes('ORDER BY l.last_price DESC')) {
      calls.push('mcap-heads');
      const quotes = strings.filter((s) => s.startsWith('0x'));
      return quotes.flatMap((q) =>
        launches
          .filter((l) => l.quote === q && (l.price ?? 0) > 0 && inPad(l))
          .sort((a, b) => (b.price as number) - (a.price as number) || newestFirst(a, b))
          .slice(0, limit)
          .map((l) => ({ token: l.token, last_price: l.price, quote: l.quote, born: l.born }))
      );
    }
    if (sql.includes('ORDER BY l.created_at DESC')) {
      const inactiveOnly = sql.includes('NOT EXISTS');
      const priced = sql.includes('l.last_price IS NOT NULL AND l.last_price <> 0');
      const unpriced = sql.includes('(l.last_price IS NULL OR l.last_price = 0)');
      const unvalued = sql.includes('NOT (l.quote = ANY');
      calls.push(`newest${inactiveOnly ? ':inactive' : ''}${priced ? ':priced' : ''}${unpriced ? ':unpriced' : ''}${unvalued ? ':unvalued' : ''}`);
      const valued = arrays[0] ?? [];
      return launches
        .filter(inPad)
        .filter((l) => !inactiveOnly || !l.day)
        .filter((l) => !priced || (l.price !== null && l.price !== 0))
        .filter((l) => !unpriced || l.price === null || l.price === 0)
        .filter((l) => !unvalued || l.price === null || l.price <= 0 || !valued.includes(l.quote))
        .sort(newestFirst)
        .slice(0, limit)
        .map((l) => ({ token: l.token }));
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  };
  return { timed, calls };
}

type Internals = {
  timed: ReturnType<typeof fakeDb>['timed'];
  readHypeUsd: () => Promise<number | null>;
  snapshot: { at: number } | null;
  orders: Map<string, unknown>;
  pages: Map<string, unknown>;
  pageGate: { stats: { running: number; waiting: number } };
  searchGate: { stats: { running: number; waiting: number } };
};

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function service(launches: Launch[]) {
  (ElysiumLaunchpadMarketService as unknown as { instance?: unknown }).instance = undefined;
  const svc = ElysiumLaunchpadMarketService.getInstance();
  const db = fakeDb(launches);
  const internals = svc as unknown as Internals;
  internals.timed = jest.fn(db.timed);
  internals.readHypeUsd = async () => HYPE_USD;
  return { svc, calls: db.calls, internals };
}

const day = (vol: number, txns: number, price24h: number | null = null) => ({
  price_24h: price24h,
  vol24: String(BigInt(vol) * 10n ** 18n),
  txns24: txns,
  traders24: txns,
});
const ids = (tokens: ElysiumLaunchTokenView[]): number[] => tokens.map((t) => Number.parseInt(t.address.slice(2), 16));

describe('launch token view', () => {
  const base = { token: token(1), launchpad: 'CorePad', kind: 'curve', creator: null, symbol: null, name: null, quote: HYPE, born: 1_790_000_000.4, graduated: false, holders: null, top10_pct: null, dev_pct: null, price: 2e-6, sold: null };

  it('values an untraded token at its last price, flat, with no volume', () => {
    const v = toLaunchTokenView(base, HYPE_USD);
    expect(v).toMatchObject({ symbol: token(1).slice(0, 8), name: '', change24h: 0, volume24h: 0, txns24h: 0, traders24h: 0, curvePct: 0, bornAt: 1_790_000_000 });
    expect(v.priceUsd).toBeCloseTo(1e-4, 12);
    expect(v.marketCap).toBeCloseTo(1e5, 6);
  });

  it('leaves a token that never traded, or whose quote has no USD value, unpriced', () => {
    expect(toLaunchTokenView({ ...base, price: null }, HYPE_USD)).toMatchObject({ priceUsd: null, change24h: null, marketCap: null, volume24h: 0 });
    expect(toLaunchTokenView({ ...base, quote: '0x' + 'ee'.repeat(20) }, HYPE_USD)).toMatchObject({ priceUsd: null, change24h: 0, marketCap: null, volume24h: null });
    expect(toLaunchTokenView(base, null)).toMatchObject({ priceUsd: null, marketCap: null, volume24h: null });
  });

  it('gives a traded token its 24h figures, the change against the price before the window', () => {
    const v = toLaunchTokenView({ ...base, quote: USDC, price: 3 }, HYPE_USD, { price_24h: 2, vol24: '5000000', txns24: 4, traders24: 3 });
    expect(v).toMatchObject({ priceUsd: 3, volume24h: 5, txns24h: 4, traders24h: 3 });
    expect(v.change24h).toBeCloseTo(50);
    // Launched inside the window: no earlier price to compare with.
    expect(toLaunchTokenView(base, HYPE_USD, { price_24h: null, vol24: '0', txns24: 1, traders24: 1 }).change24h).toBeNull();
  });

  it('reads bonding progress from what the curve sold, 100% once graduated', () => {
    const half = String(400_000_000n * 10n ** 18n);
    expect(toLaunchTokenView({ ...base, sold: half }, HYPE_USD).curvePct).toBeCloseTo(50);
    expect(toLaunchTokenView({ ...base, sold: half, graduated: true }, HYPE_USD).curvePct).toBe(100);
    expect(toLaunchTokenView({ ...base, kind: 'v3', sold: half }, HYPE_USD).curvePct).toBeNull();
  });

  it('orders totally: ties fall to the newest token, then the address', () => {
    const a = toLaunchTokenView({ ...base, token: token(2), born: 10 }, HYPE_USD);
    const b = toLaunchTokenView({ ...base, token: token(1), born: 10 }, HYPE_USD);
    const c = toLaunchTokenView({ ...base, token: token(3), born: 20 }, HYPE_USD);
    for (const sort of ['hot', 'new', 'gainers', 'mcap'] as const) {
      expect([a, b, c].sort(launchTokenSorter(sort)).map((v) => v.address)).toEqual([token(3), token(1), token(2)]);
    }
  });
});

describe('ElysiumLaunchpadMarketService', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    for (const m of Object.values(mockLog)) m.mockReset();
  });
  afterEach(() => jest.restoreAllMocks());

  // 1..3 traded over 24h; 4..6 priced but quiet; 7..8 never traded.
  const market = (): Launch[] => [
    launch(1, { price: 2, day: day(10, 1, 1) }), // +100%
    launch(2, { price: 1, day: day(30, 2, 2) }), // -50%
    launch(3, { price: 5, day: day(30, 5, 5), launchpad: 'Signal' }), // flat
    launch(4, { price: 9 }),
    launch(5, { price: 4, quote: USDC, launchpad: 'Signal' }),
    launch(6, { price: 0.5 }),
    launch(7),
    launch(8, { launchpad: 'Signal' }),
  ];

  it('hot: the traded tokens by volume then trades, then the others, newest first', async () => {
    const { svc, calls } = service(market());
    const page = await svc.getPage({ sort: 'hot', limit: 50 });
    expect(ids(page.tokens)).toEqual([3, 2, 1, 4, 5, 6, 7, 8]);
    expect(page.total).toBe(8);
    expect(page.totalCapped).toBe(false);
    expect(calls).toContain('newest:inactive');
    // The head alone fills a short page: no read of the other tokens.
    const { svc: svc2, calls: calls2 } = service(market());
    (svc2 as unknown as { getPage: typeof svc.getPage }).getPage = svc2.getPage.bind(svc2);
    const short = await svc2.getPage({ sort: 'hot', limit: 50, pad: 'CorePad' });
    expect(ids(short.tokens)).toEqual([2, 1, 4, 6, 7]);
    expect(short.total).toBe(5);
    expect(calls2.filter((c) => c.startsWith('newest:inactive'))).toHaveLength(1);
  });

  it('gainers: risers, everything flat, fallers, then everything unknown', async () => {
    const { svc } = service(market());
    const page = await svc.getPage({ sort: 'gainers', limit: 50 });
    // +100% (1); flat: traded 3 then quiet priced 4, 5, 6; -50% (2); never traded 7, 8.
    expect(ids(page.tokens)).toEqual([1, 3, 4, 5, 6, 2, 7, 8]);
    expect(page.tokens.map((t) => t.change24h)).toEqual([100, 0, 0, 0, 0, -50, null, null]);
  });

  it('new: every token, newest first', async () => {
    const { svc } = service(market());
    expect(ids((await svc.getPage({ sort: 'new', limit: 50 })).tokens)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('market cap: the quotes merged at their USD value, unvalued tokens last', async () => {
    const { svc } = service(market());
    const page = await svc.getPage({ sort: 'mcap', limit: 50 });
    // HYPE at $50: 4 -> 450, 3 -> 250, 1 -> 100, 2 -> 50, 6 -> 25; USDC 5 -> 4; then 7, 8.
    expect(ids(page.tokens)).toEqual([4, 3, 1, 2, 6, 5, 7, 8]);
    expect(page.tokens[0].marketCap).toBe(450e9);
    // A shorter page is the head of the longer one.
    expect(ids((await svc.getPage({ sort: 'mcap', limit: 50, pad: 'Signal' })).tokens)).toEqual([3, 5, 8]);
  });

  it('carries the totals and the mini lists of the snapshot on every page', async () => {
    const { svc } = service(market());
    const page = await svc.getPage({ sort: 'new', limit: 50 });
    expect(page.summary).toMatchObject({ tokens: 8, volume24h: 70 * HYPE_USD, trades24h: 8, pads: [{ launchpad: 'CorePad', tokens: 5 }, { launchpad: 'Signal', tokens: 3 }] });
    expect(ids(page.top.hot)).toEqual([3, 2, 1]);
    expect(ids(page.top.gainers)).toEqual([1, 3, 2]);
    expect(ids(page.top.fresh)).toEqual([1, 2, 3, 4, 5]);
    expect(page.hypeUsd).toBe(HYPE_USD);
    expect(page.computedAt).toBe(new Date(NOW).toISOString());
  });

  it('search: sorts the matches in the asked order and takes wildcards literally', async () => {
    const { svc, internals } = service(market());
    const page = await svc.getPage({ sort: 'mcap', limit: 50, q: ' S ' });
    expect(ids(page.tokens)).toEqual([4, 3, 1, 2, 6, 5, 7, 8]);
    expect(page.total).toBe(8);
    const none = await svc.getPage({ sort: 'hot', limit: 50, q: '50%_\\' });
    expect(none.tokens).toEqual([]);
    const patterns = (internals.timed as jest.Mock).mock.calls
      .map((c) => c[1] as { sql: string; values: unknown[] })
      .filter((q) => q.sql.includes('ILIKE'))
      .map((q) => q.values[0]);
    expect(patterns).toEqual(['%s%', '%50\\%\\_\\\\%']);
  });

  it('computes the snapshot once for everyone, serves it for a minute, then refreshes behind the last one', async () => {
    const { svc, calls, internals } = service(market());
    await Promise.all([svc.getPage({ sort: 'hot', limit: 50 }), svc.getPage({ sort: 'new', limit: 50 }), svc.getPage({ sort: 'mcap', limit: 50 })]);
    expect(calls.filter((c) => c === 'active')).toHaveLength(1);

    (Date.now as jest.Mock).mockReturnValue(NOW + 59_000);
    await svc.getPage({ sort: 'hot', limit: 50 });
    expect(calls.filter((c) => c === 'active')).toHaveLength(1);

    (Date.now as jest.Mock).mockReturnValue(NOW + 61_000);
    const stale = await svc.getPage({ sort: 'hot', limit: 50 });
    // Answered from the last snapshot at once; the new one is being computed.
    expect(stale.computedAt).toBe(new Date(NOW).toISOString());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls.filter((c) => c === 'active')).toHaveLength(2);
    expect(internals.snapshot?.at).toBe(NOW + 61_000);
    expect((await svc.getPage({ sort: 'hot', limit: 50 })).computedAt).toBe(new Date(NOW + 61_000).toISOString());
  });

  it('keeps the last snapshot when a refresh fails, and waits before trying again', async () => {
    const { svc, internals } = service(market());
    await svc.getPage({ sort: 'hot', limit: 50 });
    const working = internals.timed;
    const failing = jest.fn().mockRejectedValue(new Error('canceling statement due to statement timeout'));
    internals.timed = failing;

    (Date.now as jest.Mock).mockReturnValue(NOW + 61_000);
    // The cached page still answers; a page not built yet cannot (its read fails), the snapshot stays.
    expect(ids((await svc.getPage({ sort: 'hot', limit: 50 })).tokens)).toEqual([3, 2, 1, 4, 5, 6, 7, 8]);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockLog.warn).toHaveBeenCalledWith('ElysiumLaunchpadMarketService: snapshot refresh failed', expect.any(Object));
    const attempts = failing.mock.calls.length;

    (Date.now as jest.Mock).mockReturnValue(NOW + 70_000);
    await svc.getPage({ sort: 'hot', limit: 50 });
    await new Promise((r) => setImmediate(r));
    expect(failing.mock.calls.length).toBe(attempts); // inside the 15 s wait: no new attempt

    internals.timed = working;
    (Date.now as jest.Mock).mockReturnValue(NOW + 80_000);
    await svc.getPage({ sort: 'hot', limit: 50 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(internals.snapshot?.at).toBe(NOW + 80_000);
  });

  it('builds a page once per snapshot, and does not keep one that failed', async () => {
    const { svc, calls, internals } = service(market());
    await svc.getPage({ sort: 'new', limit: 50 });
    const reads = calls.length;
    await Promise.all([svc.getPage({ sort: 'new', limit: 50 }), svc.getPage({ sort: 'new', limit: 50 })]);
    expect(calls.length).toBe(reads);
    // Another size is the same page, cut shorter or longer: no read.
    expect((await svc.getPage({ sort: 'new', limit: 100 })).tokens).toHaveLength(8);
    expect(calls.length).toBe(reads);

    const working = internals.timed;
    internals.timed = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(svc.getPage({ sort: 'mcap', limit: 50 })).rejects.toThrow('boom');
    internals.timed = working;
    expect(ids((await svc.getPage({ sort: 'mcap', limit: 50 })).tokens)).toEqual([4, 3, 1, 2, 6, 5, 7, 8]);
  });

  // 450 tokens over two launchpads; 1..30 traded over 24h, 31..300 priced but quiet, the rest never traded.
  const large = (): Launch[] =>
    Array.from({ length: 450 }, (_, i) => {
      const n = i + 1;
      const pad = n % 3 === 0 ? 'Signal' : 'CorePad';
      if (n <= 30) return launch(n, { launchpad: pad, price: 1 + (n % 7), day: day(100 - n, n % 5, n % 4 === 0 ? null : 1 + (n % 3)) });
      if (n <= 300) return launch(n, { launchpad: pad, price: (n * 37) % 11, quote: n % 10 === 0 ? USDC : HYPE });
      return launch(n, { launchpad: pad });
    });

  it.each(['hot', 'new', 'gainers', 'mcap'] as const)('%s: the pages are the order cut in 200s, each at most 200 rows', async (sort) => {
    // The whole order, as one list: what the page of 5,000 rows used to return.
    const whole = service(large()).svc as unknown as {
      getSnapshot: () => Promise<unknown>;
      orderFor: (snap: unknown, key: string, query: object, need: number) => Promise<{ tokens: string[] }>;
    };
    const reference = await whole.orderFor(await whole.getSnapshot(), 'ref', { sort, limit: 200 }, 5000);
    expect(reference.tokens).toHaveLength(450);
    expect(new Set(reference.tokens).size).toBe(450);

    const { svc } = service(large());
    const first = await svc.getPage({ sort, limit: 50 });
    const second = await svc.getPage({ sort, limit: 200, offset: 200 });
    const third = await svc.getPage({ sort, limit: 200, offset: 400 });
    const beyond = await svc.getPage({ sort, limit: 200, offset: 600 });
    const head = await svc.getPage({ sort, limit: 200 });
    expect(first.tokens.map((t) => t.address)).toEqual(reference.tokens.slice(0, 50));
    expect(head.tokens.map((t) => t.address)).toEqual(reference.tokens.slice(0, 200));
    expect(second.tokens.map((t) => t.address)).toEqual(reference.tokens.slice(200, 400));
    expect(third.tokens.map((t) => t.address)).toEqual(reference.tokens.slice(400, 450));
    expect(beyond.tokens).toEqual([]);
    for (const page of [first, second, third, beyond]) expect(page.total).toBe(450);
    // More than a page is never returned, whatever is asked.
    expect((await svc.getPage({ sort, limit: 5000 })).tokens).toHaveLength(200);
    // An offset inside a page is read as the page it falls in.
    expect((await svc.getPage({ sort, limit: 50, offset: 250 })).tokens.map((t) => t.address)).toEqual(reference.tokens.slice(200, 250));
  });

  it('a launchpad and a search are walked the same way, the search read once for all its pages', async () => {
    const { svc, calls } = service(large());
    const pad = await svc.getPage({ sort: 'new', pad: 'CorePad', limit: 200, offset: 200 });
    expect(pad.total).toBe(300);
    expect(ids(pad.tokens)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1).filter((n) => n % 3 !== 0).slice(200, 300));

    // Every symbol starts with "S": 450 matches, three pages.
    const pages = [
      await svc.getPage({ sort: 'new', q: 'S', limit: 200 }),
      await svc.getPage({ sort: 'new', q: 'S', limit: 200, offset: 200 }),
      await svc.getPage({ sort: 'new', q: 'S', limit: 200, offset: 400 }),
    ];
    expect(pages.flatMap((p) => ids(p.tokens))).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
    expect(pages.map((p) => p.total)).toEqual([450, 450, 450]);
    expect(calls.filter((c) => c === 'search')).toHaveLength(1);
  });

  it('reads an order further only when a deeper page asks, and not past its end', async () => {
    const { svc, calls } = service(large());
    await svc.getPage({ sort: 'new', limit: 50 });
    const orderReads = (): number => calls.filter((c) => c === 'newest').length;
    // The snapshot's "just launched" list reads the newest too: count from here.
    const base = orderReads();
    await svc.getPage({ sort: 'new', limit: 200 });
    expect(orderReads()).toBe(base);
    await svc.getPage({ sort: 'new', limit: 200, offset: 200 });
    expect(orderReads()).toBe(base + 1);
    // That read went 1,000 tokens far and found the end at 450: the last page needs no other.
    await svc.getPage({ sort: 'new', limit: 200, offset: 400 });
    await svc.getPage({ sort: 'new', limit: 200, offset: 1000 });
    expect(orderReads()).toBe(base + 1);
  });

  it('keeps a bounded number of orders and pages, whatever is asked', async () => {
    const { svc, internals } = service(large());
    const pads = [undefined, 'CorePad', 'Signal'];
    const sorts = ['hot', 'new', 'gainers', 'mcap'] as const;
    for (let i = 0; i < 40; i++) {
      for (const pad of pads) {
        for (const sort of sorts) await svc.getPage({ sort, pad, limit: 200, offset: (i % 3) * 200, q: i < 2 ? undefined : `s${i}` });
      }
    }
    expect(internals.orders.size).toBeLessThanOrEqual(48);
    expect(internals.pages.size).toBeLessThanOrEqual(96);
    // The page asked last is still there; the first ones left.
    expect(internals.pages.size).toBe(96);
  });

  /** Holds every statement matching `hold` until released; counts how many run at once. */
  function blocking(internals: Internals, hold: (sql: string) => boolean) {
    const working = internals.timed;
    const state = { running: 0, peak: 0, release: [] as Array<() => void> };
    internals.timed = (async (ms: number, query: { sql: string; values: unknown[] }) => {
      if (!hold(query.sql)) return working(ms, query);
      state.running += 1;
      state.peak = Math.max(state.peak, state.running);
      await new Promise<void>((resolve) => state.release.push(resolve));
      state.running -= 1;
      return working(ms, query);
    }) as Internals['timed'];
    const drain = async (): Promise<void> => {
      while (state.release.length > 0 || state.running > 0) {
        state.release.shift()?.();
        await turn();
      }
    };
    return { state, drain };
  }

  it('runs three searches at a time over all clients, queues thirty, refuses the rest', async () => {
    const { svc, internals } = service(market());
    await svc.getPage({ sort: 'hot', limit: 50 });
    const { state, drain } = blocking(internals, (sql) => sql.includes('ILIKE'));

    const pending = Array.from({ length: 33 }, (_, i) => svc.getPage({ sort: 'hot', limit: 50, q: `q${i}` }, `client-${i}`));
    await turn();
    expect(state.running).toBe(3);
    await expect(svc.getPage({ sort: 'hot', limit: 50, q: 'one-too-many' }, 'client-late')).rejects.toBeInstanceOf(LaunchpadSearchBusyError);

    // Each finished search hands its slot to the next in line.
    await drain();
    await Promise.all(pending);
    expect(state.peak).toBe(3);
    // The queue has drained: a new search runs.
    const last = svc.getPage({ sort: 'hot', limit: 50, q: 's1' }, 'client-late');
    await turn();
    state.release.shift()?.();
    expect(ids((await last).tokens)).toEqual([1]);
  });

  it('runs one search at a time per client: a newer text replaces the one waiting, the others are not delayed', async () => {
    const { svc, internals } = service(market());
    await svc.getPage({ sort: 'hot', limit: 50 });
    const { state, drain } = blocking(internals, (sql) => sql.includes('ILIKE'));

    // One client types: its first text runs, the second waits, the third takes the second's place.
    const typed = ['pe', 'pep', 'pepe'].map((q) => svc.getPage({ sort: 'hot', limit: 50, q }, 'typing'));
    const outcomes = typed.map((p) => p.then(() => 'ok', (e: Error) => e.name));
    await turn();
    expect(state.running).toBe(1);
    await expect(typed[1]).rejects.toBeInstanceOf(LaunchpadSearchBusyError);

    // Twenty more texts from the same client change nothing for anyone else.
    const flood = Array.from({ length: 20 }, (_, i) => svc.getPage({ sort: 'hot', limit: 50, q: `f${i}` }, 'typing').then(() => 'ok', (e: Error) => e.name));
    const other = svc.getPage({ sort: 'hot', limit: 50, q: 's2' }, 'someone-else');
    await turn();
    // 'typing' still runs one; 'someone-else' got a slot at once.
    expect(state.running).toBe(2);

    await drain();
    expect(ids((await other).tokens)).toEqual([2]);
    expect(await Promise.all(outcomes)).toEqual(['ok', 'LaunchpadSearchBusyError', 'LaunchpadSearchBusyError']);
    // Of the flood, only the last text was computed.
    expect((await Promise.all(flood)).filter((o) => o === 'ok')).toHaveLength(1);
    expect(state.peak).toBe(2);
  });

  it('gives each client a share of the page reads: a flood of new pages only delays itself', async () => {
    const { svc, internals } = service(large());
    await svc.getPage({ sort: 'hot', limit: 50 });
    // Pages nobody has asked for yet: each needs a read of the launches.
    const { state, drain } = blocking(internals, (sql) => sql.includes('ORDER BY l.created_at DESC') || sql.includes('l.token = ANY'));
    // Fourteen pages nobody has asked for, all different.
    const wanted = (['new', 'hot', 'gainers'] as const)
      .flatMap((sort) => [undefined, 'CorePad', 'Signal'].flatMap((pad) => [0, 200].map((offset) => ({ sort, pad, offset, limit: 200 }))))
      .slice(0, 14);
    const flood = wanted.map((query) => svc.getPage(query, 'flood').then(() => 'ok', (e: Error) => e.name));
    await turn();
    // Two reads at once for this client and eight waiting, however many pages it asks for.
    expect(internals.pageGate.stats).toMatchObject({ running: 2, waiting: 8 });

    // A visitor asks for a page the flood has waiting in its own queue: the visitor's
    // share starts the read, it does not wait behind the flood.
    const other = svc.getPage({ sort: 'new', limit: 200 }, 'visitor');
    await turn();
    expect(internals.pageGate.stats).toMatchObject({ running: 3, waiting: 8 });

    await drain();
    expect((await other).tokens).toHaveLength(200);
    const results = await Promise.all(flood);
    // One of the fourteen was already built (the first hot page, above): it took no slot. Of the
    // other thirteen, two ran and eight waited; three were refused. Nobody else was.
    expect(results.filter((r) => r === 'ok')).toHaveLength(11);
    expect(results.filter((r) => r === 'LaunchpadBusyError')).toHaveLength(3);
    // Never more statements at once than the gate has slots.
    expect(state.peak).toBeLessThanOrEqual(3);
    expect(internals.pageGate.stats).toMatchObject({ running: 0, waiting: 0 });
    await expect(svc.getPage({ sort: 'new', limit: 200 }, 'flood')).resolves.toMatchObject({ total: 450 });
    expect(new LaunchpadBusyError().retryAfterS).toBe(1);
  });
});
