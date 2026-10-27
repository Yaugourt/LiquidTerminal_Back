/**
 * The fill-alert dispatcher consumes one network-wide stream (perp and spot
 * fills). Once the alert engine has loaded the subscriptions it drops, before
 * aggregation, every fill nobody can be alerted about — and must never drop
 * one the unfiltered pipeline would have alerted on. The oracle below is the
 * matching logic the dispatcher used before those early exits, applied to every
 * order, with spot pair ids resolved to token names. The per-user budget of
 * the engine (digests past 50 alerts/min) is lifted here: it is covered by
 * alert-engine.test.ts and would turn the oracle's alerts into digests.
 */
import type { AggregatedFill, NormalizedFill } from '../../../src/types/fill-alerts.types';
import type { ActiveFillSubscription } from '../../../src/services/telegram/telegram.fill-subscription.service';

const mockState = {
  fillListeners: new Set<(fills: NormalizedFill[]) => void>(),
  subscriptions: [] as ActiveFillSubscription[],
  loadGate: null as Promise<void> | null,
  broadcasts: [] as string[],
  /** Dedup keys claimed in "Redis". */
  claimed: new Set<string>(),
  /** Spot pair id → token name, as SpotCoinNameService resolves them. */
  spotNames: {} as Record<string, string>,
};

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../src/core/prisma.telegram.service', () => ({
  prismaTelegram: {
    telegramFillSentAlert: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  },
}));

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => true,
    claimKeys: async (keys: string[]) =>
      keys.map((key) => {
        if (mockState.claimed.has(key)) return false;
        mockState.claimed.add(key);
        return true;
      }),
  },
}));

jest.mock('../../../src/services/names/alert-wallet-names', () => ({
  prefetchWalletNames: async () => undefined,
  walletName: () => undefined,
}));

jest.mock('../../../src/clients/hypedexer/websocket/live-data.ws.client', () => ({
  HypeDexerLiveDataWSClient: {
    getInstance: () => ({
      onFill: (cb: (fills: NormalizedFill[]) => void) => {
        mockState.fillListeners.add(cb);
        return () => mockState.fillListeners.delete(cb);
      },
      start: () => undefined,
      stop: () => undefined,
    }),
  },
}));

jest.mock('../../../src/services/spot/spotCoinNames.service', () => ({
  SpotCoinNameService: {
    getInstance: () => ({
      reload: async () => undefined,
      resolve: (coin: string) => mockState.spotNames[coin] ?? coin,
    }),
  },
}));

jest.mock('../../../src/services/telegram/telegram.fill-subscription.service', () => ({
  TelegramFillSubscriptionService: {
    getInstance: () => ({
      getActiveSubscriptions: async () => {
        if (mockState.loadGate) await mockState.loadGate;
        return mockState.subscriptions;
      },
    }),
  },
}));

jest.mock('../../../src/websocket/ws.server', () => ({
  InternalWebSocketServer: {
    getInstance: () => ({
      broadcastFillAlert: (telegramId: string, message: string) => {
        mockState.broadcasts.push(`${telegramId}|${message}`);
        return 1;
      },
    }),
  },
}));

jest.mock('../../../src/utils/telegram.formatting', () => ({
  formatFillAlert: (fill: AggregatedFill, name: string) =>
    `${name}|${fill.eventId}|${fill.fillCount}|${fill.notionalUsd.toFixed(6)}`,
  formatFillDigestLine: (fill: AggregatedFill, name: string) => `digest|${name}|${fill.eventId}`,
}));

// ---------------------------------------------------------------------------

/** Pre-refactor matching, verbatim: the oracle. */
function legacyMatches(fill: AggregatedFill, sub: ActiveFillSubscription): boolean {
  if (sub.minUsd > 0 && fill.notionalUsd < sub.minUsd) return false;
  if (sub.maxUsd != null && sub.maxUsd > 0 && fill.notionalUsd > sub.maxUsd) return false;
  if (sub.filterCoins.length > 0) {
    const coinLower = fill.coin.toLowerCase();
    if (!sub.filterCoins.some((c) => c.toLowerCase() === coinLower)) return false;
  }
  if (sub.filterWallets.length > 0) {
    if (!sub.filterWallets.some((w) => w.toLowerCase() === fill.wallet)) return false;
  }
  if (sub.filterSide === 'BUY' && fill.side !== 'B') return false;
  if (sub.filterSide === 'SELL' && fill.side !== 'A') return false;
  if (sub.filterSource === 'PERP' && fill.source !== 'perp') return false;
  if (sub.filterSource === 'SPOT' && fill.source !== 'spot') return false;
  if (sub.filterDirection != null) {
    if (fill.source !== 'perp' || !fill.dir) return false;
    const isOpen = fill.dir.includes('Open');
    const isClose = fill.dir.includes('Close');
    if (sub.filterDirection === 'OPEN' && !isOpen) return false;
    if (sub.filterDirection === 'CLOSE' && !isClose) return false;
  }
  return true;
}

const WALLETS = Array.from({ length: 12 }, (_, i) => `0x${String(i).padStart(40, 'a')}`);
const COINS = ['BTC', 'ETH', 'HYPE', 'SOL', 'PURR', 'kPEPE'];

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function pick<T>(rnd: () => number, items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)];
}

function subscription(id: string, overrides: Partial<ActiveFillSubscription> = {}): ActiveFillSubscription {
  return {
    id,
    telegramUserId: `u-${id}`,
    telegramId: `t-${id}`,
    name: `sub-${id}`,
    filterCoins: [],
    filterWallets: [],
    minUsd: 0,
    filterSide: null,
    filterSource: null,
    filterDirection: null,
    maxUsd: null,
    ...overrides,
  };
}

function randomSubscriptions(rnd: () => number, count: number, walletScoped: boolean): ActiveFillSubscription[] {
  return Array.from({ length: count }, (_, i) =>
    subscription(`s${i}`, {
      // Mixed case on purpose: matching is case-insensitive.
      filterWallets: walletScoped || rnd() < 0.5
        ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, WALLETS).toUpperCase().replace('0X', '0x'))
        : [],
      filterCoins: rnd() < 0.4 ? [pick(rnd, COINS).toLowerCase(), pick(rnd, COINS)] : [],
      minUsd: rnd() < 0.3 ? Math.floor(rnd() * 5000) : 0,
      maxUsd: rnd() < 0.2 ? 5000 + Math.floor(rnd() * 20000) : null,
      filterSide: rnd() < 0.2 ? pick(rnd, ['BUY', 'SELL'] as const) : null,
      filterSource: rnd() < 0.2 ? pick(rnd, ['PERP', 'SPOT'] as const) : null,
      filterDirection: rnd() < 0.2 ? pick(rnd, ['OPEN', 'CLOSE'] as const) : null,
    })
  );
}

/** Spot pair ids of COINS ("@0" = BTC, …); "@99" is a pair SpotCoinNameService does not know yet. */
const SPOT_PAIRS = [...COINS.map((_, i) => `@${i}`), '@99'];
const SPOT_NAMES: Record<string, string> = Object.fromEntries(COINS.map((coin, i) => [`@${i}`, coin]));

interface Stream {
  /** Frames as the live-data client emits them: perp and spot fills mixed, spot coin = pair id. */
  batches: NormalizedFill[][];
  /** The same fills as the aggregator must receive them: spot pair ids resolved to token names. */
  normalized: NormalizedFill[];
}

function randomStream(rnd: () => number, orders: number): Stream {
  const batches: Stream['batches'] = [];
  const normalized: NormalizedFill[] = [];
  let oid = 1000;
  for (let o = 0; o < orders; o++) {
    oid += 1;
    const source = rnd() < 0.6 ? 'perp' : 'spot';
    const wallet = pick(rnd, WALLETS);
    const coin = source === 'perp' ? pick(rnd, COINS) : pick(rnd, SPOT_PAIRS);
    const side = rnd() < 0.5 ? 'A' : 'B';
    const dir = pick(rnd, ['Open Long', 'Close Short', 'Open Short', 'Close Long', undefined]);
    const fillCount = 1 + Math.floor(rnd() * 4);
    const batch: NormalizedFill[] = [];
    for (let f = 0; f < fillCount; f++) {
      const px = 1 + rnd() * 100;
      const sz = rnd() * 200;
      const common = {
        oid, wallet, coin, px, sz, notionalUsd: px * sz, side,
        time: 1_790_000_000_000 + o, hash: `0xh${oid}`, twapId: null,
      } as const;
      if (source === 'perp') {
        const fill: NormalizedFill = { source: 'perp', ...common, dir, closedPnl: 0 };
        batch.push(fill);
        normalized.push(fill);
      } else {
        const fill: NormalizedFill = { source: 'spot', ...common };
        batch.push(fill);
        normalized.push({ ...fill, coin: SPOT_NAMES[coin] ?? coin });
      }
    }
    batches.push(batch);
  }
  return { batches, normalized };
}

const drain = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('TelegramFillAlertDispatcherService', () => {
  let Dispatcher: typeof import('../../../src/services/telegram/telegram.fill-alert-dispatcher.service').TelegramFillAlertDispatcherService;
  let FillAggregator: typeof import('../../../src/services/telegram/fill-aggregator').FillAggregator;
  let addSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockState.fillListeners.clear();
    mockState.subscriptions = [];
    mockState.loadGate = null;
    mockState.broadcasts = [];
    mockState.claimed.clear();
    mockState.spotNames = SPOT_NAMES;
    FillAggregator = require('../../../src/services/telegram/fill-aggregator').FillAggregator;
    addSpy = jest.spyOn(FillAggregator.prototype, 'add');
    const { DeliveryLimiter } = require('../../../src/services/alerts/alert-engine');
    jest.spyOn(DeliveryLimiter.prototype, 'allow').mockReturnValue(true);
    Dispatcher = require('../../../src/services/telegram/telegram.fill-alert-dispatcher.service')
      .TelegramFillAlertDispatcherService;
  });

  afterEach(() => {
    Dispatcher.getInstance().stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const emit = (stream: Stream): void => {
    for (const batch of stream.batches) for (const cb of mockState.fillListeners) cb(batch);
  };

  /** Alerts the unfiltered pipeline would have produced for this stream. */
  const expectedAlerts = (stream: Stream, subs: ActiveFillSubscription[]): string[] => {
    const orders: AggregatedFill[] = [];
    const reference = new FillAggregator((agg) => orders.push(agg));
    for (const fill of stream.normalized) reference.add(fill);
    jest.advanceTimersByTime(2_500);
    const alerts: string[] = [];
    for (const order of orders) {
      for (const sub of subs) {
        if (legacyMatches(order, sub)) {
          alerts.push(`${sub.telegramId}|${sub.name}|${order.eventId}|${order.fillCount}|${order.notionalUsd.toFixed(6)}`);
        }
      }
    }
    return alerts.sort();
  };

  const run = async (stream: Stream): Promise<string[]> => {
    emit(stream);
    jest.advanceTimersByTime(2_500);
    await drain();
    return [...mockState.broadcasts].sort();
  };

  it('drops every fill without aggregating it when nobody is subscribed', async () => {
    Dispatcher.getInstance().start();
    await drain();
    const stream = randomStream(rng(1), 400);
    expect(await run(stream)).toEqual([]);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('aggregates only the fills of watched wallets when every subscription is wallet-scoped', async () => {
    const rnd = rng(2);
    mockState.subscriptions = randomSubscriptions(rnd, 5, true);
    Dispatcher.getInstance().start();
    await drain();

    const stream = randomStream(rnd, 600);
    const watched = new Set(mockState.subscriptions.flatMap((s) => s.filterWallets.map((w) => w.toLowerCase())));
    const expected = expectedAlerts(stream, mockState.subscriptions);
    addSpy.mockClear();

    const alerts = await run(stream);
    expect(alerts).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
    const aggregatedWallets = new Set(addSpy.mock.calls.map(([fill]) => (fill as NormalizedFill).wallet));
    for (const wallet of aggregatedWallets) expect(watched.has(wallet)).toBe(true);
    expect(addSpy.mock.calls.length).toBe(stream.normalized.filter((f) => watched.has(f.wallet)).length);
  });

  it.each([3, 4, 5, 6, 7, 8])('alerts exactly like the unfiltered pipeline (mixed subscriptions, seed %i)', async (seed) => {
    const rnd = rng(seed);
    mockState.subscriptions = randomSubscriptions(rnd, 8, false);
    Dispatcher.getInstance().start();
    await drain();

    const stream = randomStream(rnd, 800);
    const expected = expectedAlerts(stream, mockState.subscriptions);
    expect(expected.length).toBeGreaterThan(0);
    expect(await run(stream)).toEqual(expected);
  });

  it('keeps the unfiltered path until the first subscription load completes', async () => {
    let release!: () => void;
    mockState.loadGate = new Promise<void>((resolve) => { release = resolve; });
    mockState.subscriptions = [subscription('a', { filterWallets: [WALLETS[0]] })];
    Dispatcher.getInstance().start();
    await drain();

    const stream = randomStream(rng(9), 50);
    emit(stream);
    expect(addSpy).toHaveBeenCalledTimes(stream.normalized.length);

    release();
    jest.advanceTimersByTime(2_500);
    await drain();
    expect([...mockState.broadcasts].sort()).toEqual(expectedAlerts(stream, mockState.subscriptions));
  });

  it('picks up subscriptions created after start within one refresh period', async () => {
    Dispatcher.getInstance().start();
    await drain();
    mockState.subscriptions = [subscription('late')];

    jest.advanceTimersByTime(30_000);
    await drain();

    const stream = randomStream(rng(10), 20);
    expect(await run(stream)).toEqual(expectedAlerts(stream, mockState.subscriptions));
    expect(mockState.broadcasts.length).toBe(20);
  });

  it('filters and alerts spot fills under the token name, not the pair id', async () => {
    mockState.subscriptions = [
      subscription('spot-hype', { filterCoins: ['HYPE'], filterSource: 'SPOT' }),
      subscription('perp-only', { filterSource: 'PERP' }),
    ];
    Dispatcher.getInstance().start();
    await drain();

    const hypeSpot: NormalizedFill = {
      source: 'spot', oid: 7, wallet: WALLETS[0], coin: '@2', px: 10, sz: 3, notionalUsd: 30,
      side: 'B', time: 1_790_000_000_000, hash: '0xh7', twapId: null,
    };
    // A pair listed after the last load keeps its id until the next reload.
    const unknownSpot: NormalizedFill = { ...hypeSpot, oid: 8, coin: '@99', hash: '0xh8' };
    for (const cb of mockState.fillListeners) cb([hypeSpot, unknownSpot]);
    jest.advanceTimersByTime(2_500);
    await drain();

    expect(addSpy.mock.calls.map(([fill]) => (fill as NormalizedFill).coin)).toEqual(['HYPE', '@99']);
    expect(mockState.broadcasts).toEqual([`t-spot-hype|sub-spot-hype|spot:7:${WALLETS[0]}:1790000000000|1|30.000000`]);
  });
});
