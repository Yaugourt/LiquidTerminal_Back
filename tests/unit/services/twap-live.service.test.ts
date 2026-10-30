/**
 * The live TWAP book: fills and status events from HypeDexer's socket, seeded
 * from /twaps/:id for the TWAPs that started before the connection. The socket
 * and REST sides are faked; time is a variable.
 */
import type { NormalizedFill } from '../../../src/types/fill-alerts.types';
import type { TwapLiveDelta, TwapStatusEvent } from '../../../src/types/twap-live.types';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/indexer/indexer-twaps.service', () => ({
  IndexerTwapsService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/clients/hypedexer/websocket/live-data.ws.client', () => ({
  HypeDexerLiveDataWSClient: { getInstance: () => ({}) },
}));

import { TwapLiveService, TwapLiveUpstreamClient } from '../../../src/services/twap/twap-live.service';
import { logDeduplicator } from '../../../src/utils/logDeduplicator';

const T0 = 1_793_000_000_000;
const MIN = 60_000;
const SEED_COOLDOWN = 10 * MIN;

class FakeClient implements TwapLiveUpstreamClient {
  public fillCbs = new Set<(fills: NormalizedFill[]) => void>();
  public statusCbs = new Set<(events: TwapStatusEvent[]) => void>();
  public connCbs = new Set<(connected: boolean, at: number) => void>();
  public connection: { connected: boolean; at: number | null } = { connected: false, at: null };
  public start = jest.fn();
  public stop = jest.fn();

  public onFill(cb: (fills: NormalizedFill[]) => void): () => void {
    this.fillCbs.add(cb);
    return () => this.fillCbs.delete(cb);
  }
  public onTwapStatus(cb: (events: TwapStatusEvent[]) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }
  public onConnectionChange(cb: (connected: boolean, at: number) => void): () => void {
    this.connCbs.add(cb);
    return () => this.connCbs.delete(cb);
  }
  public getConnection(): { connected: boolean; at: number | null } {
    return this.connection;
  }

  public fills(fills: NormalizedFill[]): void {
    for (const cb of this.fillCbs) cb(fills);
  }
  public statuses(events: TwapStatusEvent[]): void {
    for (const cb of this.statusCbs) cb(events);
  }
  public setConnected(connected: boolean, at: number): void {
    this.connection = { connected, at: connected ? at : null };
    for (const cb of this.connCbs) cb(connected, at);
  }
}

let tid = 0;
function fill(twapId: number | null, time: number, sz = 1, px = 100, overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  tid += 1;
  return {
    source: 'perp', oid: 1, tid, wallet: '0xabc', coin: 'BTC', px, sz, notionalUsd: px * sz, side: 'B',
    time, hash: '0xh', twapId, dir: 'Open Long', closedPnl: 0, ...overrides,
  };
}

function status(twapId: number, overrides: Partial<TwapStatusEvent> = {}): TwapStatusEvent {
  return {
    twapId, status: 'activated', time: T0 + 5_000, coin: 'BTC', user: '0xabc', side: 'B', sz: 10,
    executedSz: 0, executedNtl: 0, minutes: 30, reduceOnly: false, randomize: true, startTime: T0 + 4_000,
    isSnapshot: false, ...overrides,
  };
}

/** A /twaps/:id payload (after the envelope is peeled), summary `fills`. */
function detail(fillCount: number, totalSz: number, totalNotional: number, lastFill?: string, coin = 'BTC'): unknown {
  return { coin, fills: { fillCount, totalSz, totalNotional, lastFill } };
}

/** A realistic /twaps/:id payload (envelope peeled): `meta`, `events`, `fills`. */
function payload(meta: Record<string, unknown>, fills?: Record<string, unknown>): unknown {
  return {
    meta: {
      twapId: 1, status: 'activated', coin: 'ETH', user: '0xABCDEF0000000000000000000000000000000001', side: 'A', sz: 30,
      executedSz: 0, executedNtl: 0, executionPct: 0, minutes: 60, reduceOnly: true, randomize: false,
      startTime: '2026-10-30T14:47:00', updatedAt: '2026-10-30T14:47:00.244366', ...meta,
    },
    events: [],
    fills: fills ?? { fillCount: 0, totalNotional: 0, totalSz: 0 },
  };
}

function restRow(twapId: number, startTime: string, coin = 'BTC'): Record<string, unknown> {
  return { twapId, coin, status: 'activated', startTime };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const iso = (ms: number): string => new Date(ms).toISOString().replace('Z', '000'); // UTC, no zone suffix, microseconds

describe('TwapLiveService', () => {
  let client: FakeClient;
  let now: number;
  let running: Array<Record<string, unknown>>;
  let deepRunning: Array<Record<string, unknown>> | null;
  let fetchTwap: jest.Mock;
  let getSource: jest.Mock;
  let getDeep: jest.Mock;
  let svc: TwapLiveService;
  let deltas: TwapLiveDelta[];

  beforeEach(() => {
    tid = 0;
    client = new FakeClient();
    now = T0 + 10_000;
    running = [];
    deepRunning = null;
    fetchTwap = jest.fn(async () => detail(0, 0, 0));
    getSource = jest.fn(async () => ({ recent: [], running, deepAt: { recent: null, running: deepRunning ? now : null }, updatedAt: now }) as never);
    getDeep = jest.fn(async () => ({ recent: null, running: deepRunning ? { at: now, rows: deepRunning } : null }) as never);
    svc = new TwapLiveService({
      client,
      now: () => now,
      seedGapMs: 0,
      fetchTwap,
      source: { getTwapSource: getSource, getTwapSourceDeep: getDeep },
    });
    (logDeduplicator.warn as jest.Mock).mockClear();
    deltas = [];
    svc.start();
  });

  afterEach(() => svc.stop());

  const connect = async (at = T0): Promise<void> => {
    client.setConnected(true, at);
    await settle();
  };
  const entry = (twapId: number) => svc.peek(twapId); // withheld entries included
  const sent = (twapId: number) => svc.getSnapshot().entries.find((e) => e.twapId === twapId);
  const listen = (): void => {
    svc.onDelta((d) => deltas.push(d));
  };

  describe('lifecycle', () => {
    it('acquires the client on start and releases it, with its callbacks, on stop', () => {
      expect(client.start).toHaveBeenCalledTimes(1);
      expect(client.fillCbs.size + client.statusCbs.size + client.connCbs.size).toBe(3);
      svc.stop();
      expect(client.stop).toHaveBeenCalledTimes(1);
      expect(client.fillCbs.size + client.statusCbs.size + client.connCbs.size).toBe(0);
      svc.stop(); // idempotent
      expect(client.stop).toHaveBeenCalledTimes(1);
    });

    it('counts an already open socket from the moment the book started', () => {
      svc.stop();
      client = new FakeClient();
      client.connection = { connected: true, at: T0 - 60_000 };
      svc = new TwapLiveService({ client, now: () => now, seedGapMs: 0, fetchTwap, source: { getTwapSource: async () => ({ running: [], deepAt: { recent: null, running: null } }) as never, getTwapSourceDeep: async () => ({ running: null }) as never } });
      svc.start();
      expect(svc.getSnapshot().upstream).toEqual({ connected: true, since: now });
    });

    it('never throws out of a callback', () => {
      expectNoThrow(() => client.fills([{ twapId: 1, tid: 1 } as unknown as NormalizedFill]));
      expectNoThrow(() => client.statuses([null as unknown as TwapStatusEvent]));
    });
  });

  describe('fills and status events', () => {
    it('takes a fill before the activated event, then the event completes the entry', async () => {
      await connect(T0);
      client.fills([fill(7, T0 + 6_500, 2, 100)]);
      expect(entry(7)).toEqual({ twapId: 7, executedSz: 2, executedNtl: 200, fills: 1, lastFillAt: T0 + 6_500, lastPx: 100, exact: false });

      client.statuses([status(7, { coin: 'BTC', startTime: T0 + 6_000 })]);
      expect(entry(7)).toMatchObject({
        twapId: 7, status: 'activated', coin: 'BTC', user: '0xabc', side: 'B', sz: 10, minutes: 30,
        reduceOnly: false, randomize: true, startTime: T0 + 6_000, statusAt: T0 + 5_000,
        executedSz: 2, executedNtl: 200, fills: 1, exact: true,
      });
    });

    it('is exact only when the TWAP started on this connection', async () => {
      await connect(T0);
      client.statuses([status(1, { startTime: T0 + 5_000 }), status(2, { startTime: T0 + 4_999 })]);
      expect(entry(1)?.exact).toBe(true);
      expect(entry(2)?.exact).toBe(false);
    });

    it('sums fills: size, notional, count, last fill and price', async () => {
      await connect(T0);
      client.statuses([status(3)]);
      client.fills([fill(3, T0 + 6_000, 1, 100), fill(3, T0 + 7_000, 2, 110), fill(null, T0 + 8_000)]);
      expect(entry(3)).toMatchObject({ executedSz: 3, executedNtl: 320, fills: 2, lastFillAt: T0 + 7_000, lastPx: 110 });
    });

    it('dedupes fills by trade id', async () => {
      await connect(T0);
      const f = fill(4, T0 + 6_000, 1, 100);
      client.fills([f]);
      client.fills([f, { ...f }]);
      expect(entry(4)).toMatchObject({ fills: 1, executedSz: 1 });
      // The same trade id on another TWAP is another fill (both sides of a trade).
      client.fills([{ ...f, twapId: 5 }]);
      expect(entry(5)).toMatchObject({ fills: 1 });
    });

    it('keeps an ended TWAP final: totals replaced, exact, never reopened, fills ignored', async () => {
      await connect(T0);
      client.statuses([status(8, { startTime: T0 - MIN })]);
      client.fills([fill(8, T0 + 6_000, 1, 100)]);
      expect(entry(8)).toMatchObject({ exact: false, executedSz: 1 });

      client.statuses([status(8, { status: 'terminated', time: T0 + 9_000, executedSz: 40, executedNtl: 4_000, startTime: T0 - MIN })]);
      expect(entry(8)).toMatchObject({ status: 'terminated', statusAt: T0 + 9_000, executedSz: 40, executedNtl: 4_000, exact: true });

      // A replayed or newer 'activated' (carrying 0) and a late slice change nothing.
      client.statuses([status(8, { time: T0 + 20_000, startTime: T0 - MIN })]);
      client.fills([fill(8, T0 + 9_500, 5, 100)]);
      expect(entry(8)).toMatchObject({ status: 'terminated', executedSz: 40, executedNtl: 4_000, fills: 1 });
    });

    it('lets the newer of two ended events win', async () => {
      await connect(T0);
      client.statuses([status(9, { status: 'terminated', time: T0 + 9_000, executedSz: 40, executedNtl: 4_000 })]);
      client.statuses([status(9, { status: 'finished', time: T0 + 8_000, executedSz: 10, executedNtl: 1_000 })]);
      expect(entry(9)).toMatchObject({ status: 'terminated', executedSz: 40 });
      client.statuses([status(9, { status: 'finished', time: T0 + 9_500, executedSz: 50, executedNtl: 5_000 })]);
      expect(entry(9)).toMatchObject({ status: 'finished', executedSz: 50, statusAt: T0 + 9_500 });
    });

    it('applies a replayed snapshot idempotently', async () => {
      await connect(T0);
      listen();
      const snapshot = [
        status(10, { isSnapshot: true }),
        status(11, { isSnapshot: true, status: 'finished', time: T0 + 8_000, executedSz: 3, executedNtl: 300 }),
      ];
      client.statuses(snapshot);
      client.fills([fill(10, T0 + 6_000, 2, 100)]);
      const before = svc.getSnapshot().entries;
      svc.flush();
      deltas.length = 0;

      client.statuses(snapshot);
      expect(svc.getSnapshot().entries).toEqual(before);
      svc.flush();
      expect(deltas).toEqual([]); // nothing changed, nothing sent
    });

    it('does not add an ended event too old to be kept', async () => {
      await connect(T0);
      client.statuses([status(12, { status: 'finished', time: now - 11 * MIN })]);
      expect(entry(12)).toBeUndefined();
    });
  });

  describe('seeding', () => {
    it('seeds from the REST summary on connect', async () => {
      running = [restRow(20, iso(T0 - 20 * MIN))];
      fetchTwap.mockResolvedValue(detail(5, 50, 5_000, iso(T0 + 1_000)));
      await connect(T0);
      // Not in the book (the socket never mentioned it): the sweep on connect seeded it from REST alone.
      expect(entry(20)).toMatchObject({ executedSz: 50, executedNtl: 5_000, fills: 5, exact: true });
      expect(fetchTwap).toHaveBeenCalledTimes(1);
    });

    it('adds only the socket fills after the summary\'s last fill', async () => {
      client.setConnected(true, T0);
      await settle();
      client.statuses([status(21, { startTime: T0 - 20 * MIN })]);
      client.fills([
        fill(21, T0 + 1_000, 1, 100), // covered by the summary (== lastFill)
        fill(21, T0 + 500, 1, 100), // older
        fill(21, T0 + 2_000, 2, 110), // after: lost to REST lag
      ]);
      expect(entry(21)).toMatchObject({ exact: false, executedSz: 4 });

      fetchTwap.mockResolvedValue(detail(5, 50, 5_000, iso(T0 + 1_000)));
      await svc.runSweep();

      expect(fetchTwap).toHaveBeenCalledWith(21);
      expect(entry(21)).toMatchObject({
        exact: true, executedSz: 52, executedNtl: 5_220, fills: 6, lastFillAt: T0 + 2_000, lastPx: 110,
      });
    });

    it('takes the buffered fills alone when the summary has no fill yet', async () => {
      client.setConnected(true, T0);
      await settle();
      client.statuses([status(22, { startTime: T0 - 20 * MIN })]);
      client.fills([fill(22, T0 + 2_000, 1, 100), fill(22, T0 + 3_000, 1, 100)]);
      fetchTwap.mockResolvedValue(detail(0, 0, 0));
      await svc.runSweep();
      expect(entry(22)).toMatchObject({ exact: true, executedSz: 2, fills: 2 });
    });

    it('parses REST times as UTC, with or without a zone suffix', async () => {
      client.setConnected(true, T0);
      await settle();
      client.statuses([status(23, { startTime: T0 - 20 * MIN })]);
      client.fills([fill(23, T0 + 1_500, 1, 100)]);
      fetchTwap.mockResolvedValue(detail(2, 20, 2_000, new Date(T0 + 1_000).toISOString().replace('Z', '')));
      await svc.runSweep();
      expect(entry(23)).toMatchObject({ exact: true, executedSz: 21, fills: 3 });
    });

    it('seeds a running TWAP the socket never mentioned, from the deep rows too', async () => {
      running = [restRow(30, iso(T0 - MIN))];
      deepRunning = [restRow(31, iso(T0 - 3 * MIN))];
      fetchTwap.mockImplementation(async (id: number) => detail(1, id, id * 100, iso(T0 - 1_000)));
      await connect(T0);
      expect(entry(30)).toMatchObject({ exact: true, executedSz: 30, fills: 1, lastFillAt: T0 - 1_000 });
      expect(entry(31)).toMatchObject({ exact: true, executedSz: 31 });
      expect(entry(30)?.status).toBeUndefined(); // progress only: the front has the rest from REST
    });

    it('never seeds spot TWAPs, exact ones, TWAPs that started on this connection, or ended ones', async () => {
      running = [
        restRow(40, iso(T0 - MIN), '@107'),
        restRow(41, iso(T0 - MIN), 'PURR/USDC'),
        restRow(42, iso(T0 + 6_000)), // started after the connection (past the margin)
        restRow(43, iso(T0 - MIN)), // ended below
        restRow(44, iso(T0 - MIN)), // exact below
      ];
      client.setConnected(true, T0);
      client.statuses([
        status(43, { status: 'finished', time: T0 + 2_000, startTime: T0 - MIN }),
        status(44, { startTime: T0 + 6_000 }),
        status(45, { coin: 'PURR/USDC', startTime: T0 - MIN }), // known to the book, spot
      ]);
      await settle();
      await svc.runSweep();
      expect(fetchTwap).not.toHaveBeenCalled();
    });

    it('leaves an empty summary non-exact and does not retry it in this epoch', async () => {
      running = [restRow(50, iso(T0 - MIN))];
      fetchTwap.mockResolvedValue({ coin: 'BTC', fills: null });
      await connect(T0);
      expect(fetchTwap).toHaveBeenCalledTimes(1);
      await svc.runSweep();
      await svc.runSweep();
      expect(fetchTwap).toHaveBeenCalledTimes(1);
      expect(entry(50)).toBeUndefined();
    });

    it('retries a failed fetch on a later sweep, without looping', async () => {
      running = [restRow(51, iso(T0 - MIN))];
      fetchTwap.mockRejectedValueOnce(new Error('503'));
      await connect(T0);
      expect(fetchTwap).toHaveBeenCalledTimes(1);
      expect(entry(51)).toBeUndefined();

      fetchTwap.mockResolvedValue(detail(1, 5, 500, iso(T0 - 1_000)));
      await svc.runSweep();
      expect(fetchTwap).toHaveBeenCalledTimes(2);
      expect(entry(51)).toMatchObject({ exact: true, executedSz: 5 });
    });

    it('stops a sweep after repeated failures', async () => {
      running = Array.from({ length: 20 }, (_, i) => restRow(100 + i, iso(T0 - MIN)));
      fetchTwap.mockRejectedValue(new Error('429'));
      await connect(T0);
      expect(fetchTwap.mock.calls.length).toBeLessThanOrEqual(6); // 5 in a row, plus the other worker's call in flight
    });

    it('runs at most two fetches at a time and caps the fetches per connection', async () => {
      running = Array.from({ length: 900 }, (_, i) => restRow(1_000 + i, iso(T0 - MIN)));
      let inFlight = 0;
      let peak = 0;
      fetchTwap.mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await settle();
        inFlight--;
        return detail(0, 0, 0);
      });
      client.setConnected(true, T0);
      for (let i = 0; i < 1_000 && fetchTwap.mock.calls.length < 800; i++) await settle();
      await settle();
      await svc.runSweep();
      expect(peak).toBe(2);
      expect(fetchTwap).toHaveBeenCalledTimes(800);
    }, 30_000);

    it('discards a summary that comes back after the connection dropped', async () => {
      running = [restRow(60, iso(T0 - MIN))];
      let release: (value: unknown) => void = () => undefined;
      fetchTwap.mockImplementation(() => new Promise((resolve) => (release = resolve)));
      client.setConnected(true, T0);
      await settle();
      client.statuses([status(60, { startTime: T0 - MIN })]);
      client.setConnected(false, T0 + 1_000);
      release(detail(9, 90, 9_000, iso(T0 - 1_000)));
      await settle();
      expect(entry(60)).toMatchObject({ exact: false, executedSz: 0 });
    });

    it('marks running entries non-exact on disconnect, seeds them again after the reconnect', async () => {
      running = [restRow(70, iso(T0 - MIN))];
      fetchTwap.mockResolvedValue(detail(2, 20, 2_000, iso(T0 - 1_000)));
      await connect(T0);
      client.statuses([
        status(71, { startTime: T0 + 6_000 }), // started on the connection: exact
        status(72, { status: 'finished', time: T0 + 2_000, executedSz: 7, executedNtl: 700, startTime: T0 + 500 }),
      ]);
      expect(entry(70)?.exact).toBe(true);
      expect(entry(71)?.exact).toBe(true);

      client.setConnected(false, T0 + 5_000);
      expect(svc.getSnapshot().upstream).toEqual({ connected: false, since: null });
      expect(entry(70)?.exact).toBe(false);
      expect(entry(71)?.exact).toBe(false);
      expect(entry(72)).toMatchObject({ exact: true, executedSz: 7 }); // ended: final

      running = [restRow(70, iso(T0 - MIN)), restRow(71, iso(T0 + 6_000))];
      fetchTwap.mockResolvedValue(detail(4, 40, 4_000, iso(T0 + 4_000)));
      now += SEED_COOLDOWN; // a reconnect sooner than this waits (see the cooldown test)
      client.setConnected(true, now);
      await settle();
      expect(fetchTwap).toHaveBeenCalledTimes(3); // 70 once at the first connect, then 70 and 71
      expect(entry(70)).toMatchObject({ exact: true, executedSz: 40 });
      expect(entry(71)).toMatchObject({ exact: true, executedSz: 40 });
      expect(svc.getSnapshot().upstream).toEqual({ connected: true, since: now });
    });
  });

  describe('terminal statuses', () => {
    it.each(['finished', 'terminated', 'stopped', 'canceled', 'cancelled', 'error: insufficient margin', 'errorX'])(
      '%s is final: later fills and a later activated change nothing',
      async (terminal) => {
        await connect(T0);
        client.statuses([status(300, { startTime: T0 + 6_000 })]);
        client.statuses([status(300, { status: terminal, time: T0 + 8_000, executedSz: 9, executedNtl: 900, startTime: T0 + 6_000 })]);
        client.fills([fill(300, T0 + 8_500, 5, 100)]);
        client.statuses([status(300, { time: T0 + 9_000, startTime: T0 + 6_000 })]);
        expect(entry(300)).toMatchObject({ status: terminal, statusAt: T0 + 8_000, executedSz: 9, executedNtl: 900, fills: 0 });
      }
    );

    it('treats waitingForTrigger, activated and unknown statuses as live: fills accumulate, a later event wins', async () => {
      await connect(T0);
      client.statuses([status(301, { status: 'waitingForTrigger', time: T0 + 5_000, startTime: T0 + 6_000 })]);
      client.fills([fill(301, T0 + 6_500, 2, 100)]);
      expect(entry(301)).toMatchObject({ status: 'waitingForTrigger', executedSz: 2, fills: 1 });

      client.statuses([status(301, { status: 'activated', time: T0 + 7_000, startTime: T0 + 6_000 })]);
      expect(entry(301)).toMatchObject({ status: 'activated', statusAt: T0 + 7_000, executedSz: 2 });

      client.statuses([status(301, { status: 'somethingNew', time: T0 + 7_500, startTime: T0 + 6_000 })]);
      client.fills([fill(301, T0 + 8_000, 1, 100)]);
      expect(entry(301)).toMatchObject({ status: 'somethingNew', executedSz: 3, fills: 2 });

      // An older live event is stale.
      client.statuses([status(301, { status: 'activated', time: T0 + 7_100, startTime: T0 + 6_000 })]);
      expect(entry(301)?.status).toBe('somethingNew');
    });

    it('applies only the newest event of a TWAP within one batch', async () => {
      await connect(T0);
      const staleEnd = status(302, { status: 'finished', time: now - 11 * MIN });
      const olderActive = status(302, { time: now - 12 * MIN });
      client.statuses([staleEnd, olderActive]);
      expect(entry(302)).toBeUndefined();
      client.statuses([olderActive, staleEnd]);
      expect(entry(302)).toBeUndefined();

      client.statuses([
        status(303, { time: T0 + 5_000, startTime: T0 + 6_000 }),
        status(303, { status: 'waitingForTrigger', time: T0 + 7_000, startTime: T0 + 6_000 }),
        status(303, { time: T0 + 6_000, startTime: T0 + 6_000 }),
      ]);
      expect(entry(303)).toMatchObject({ status: 'waitingForTrigger', statusAt: T0 + 7_000 });
    });
  });

  describe('fill guards', () => {
    it('ignores fills whose price or size is not finite', async () => {
      await connect(T0);
      client.fills([fill(310, T0 + 6_000, Number.NaN, 100), fill(310, T0 + 6_100, 1, Number.NaN), fill(310, T0 + 6_200, Infinity, 100)]);
      expect(entry(310)).toBeUndefined();
      client.fills([fill(310, T0 + 6_300, 1, 100)]);
      expect(entry(310)).toMatchObject({ executedSz: 1, executedNtl: 100, fills: 1 });
    });

    it('prices a fill from px * sz when its notional is missing', async () => {
      await connect(T0);
      client.fills([fill(311, T0 + 6_000, 2, 100, { notionalUsd: Number.NaN })]);
      expect(entry(311)).toMatchObject({ executedNtl: 200 });
    });

    it('dedupes on hash + time + size when the trade id is not a number', async () => {
      await connect(T0);
      const noTid = (hash: string, time: number, sz: number): NormalizedFill =>
        fill(312, time, sz, 100, { tid: undefined as unknown as number, hash });
      client.fills([noTid('0xa', T0 + 6_000, 1), noTid('0xa', T0 + 6_000, 1), noTid('0xa', T0 + 6_000, Number.NaN)]);
      expect(entry(312)).toMatchObject({ fills: 1, executedSz: 1 });
      client.fills([noTid('0xb', T0 + 6_000, 1), noTid('0xa', T0 + 6_001, 1), noTid('0xa', T0 + 6_000, 2)]);
      expect(entry(312)).toMatchObject({ fills: 4, executedSz: 5 });
      // NaN as a trade id is not an id either.
      client.fills([fill(313, T0 + 6_000, 1, 100, { tid: Number.NaN }), fill(313, T0 + 6_000, 1, 100, { tid: Number.NaN })]);
      expect(entry(313)).toMatchObject({ fills: 1 });
    });
  });

  describe('exact boundary', () => {
    it('counts a TWAP as tracked from its start only 5 s past the connection, and seeds the others', async () => {
      client.setConnected(true, T0);
      client.statuses([status(320, { startTime: T0 + 4_999 }), status(321, { startTime: T0 + 5_000 })]);
      expect(entry(320)?.exact).toBe(false);
      expect(entry(321)?.exact).toBe(true);
      await settle();
      expect(fetchTwap.mock.calls.map((call) => call[0])).toEqual([320]);
    });
  });

  describe('discovery', () => {
    it('reads the REST list once per connection and never on later sweeps', async () => {
      running = [restRow(330, iso(T0 - MIN))];
      await connect(T0);
      await svc.runSweep();
      await svc.runSweep();
      await svc.runSweep();
      expect(getSource).toHaveBeenCalledTimes(1);
      expect(getDeep).not.toHaveBeenCalled();
    });

    it('reads the deep rows only when the first page is full, and only once', async () => {
      running = [restRow(331, iso(T0 - MIN))];
      deepRunning = [restRow(332, iso(T0 - 2 * MIN))];
      await connect(T0);
      await svc.runSweep();
      expect(getSource).toHaveBeenCalledTimes(1);
      expect(getDeep).toHaveBeenCalledTimes(1);
      expect(fetchTwap.mock.calls.map((call) => call[0]).sort()).toEqual([331, 332]);
    });

    it('retries a failed list read on the next sweeps, at most 10 times per connection, seeding nothing meanwhile', async () => {
      running = [restRow(333, iso(T0 - MIN))];
      getSource.mockRejectedValue(new Error('503'));
      await connect(T0);
      expect(getSource).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 12; i++) await svc.runSweep();
      expect(getSource).toHaveBeenCalledTimes(10);
      expect(fetchTwap).not.toHaveBeenCalled();
    });

    it('seeds once a retried read succeeds, and stops reading', async () => {
      running = [restRow(334, iso(T0 - MIN))];
      getSource.mockRejectedValueOnce(new Error('503'));
      fetchTwap.mockResolvedValue(detail(1, 5, 500, iso(T0 - 1_000)));
      await connect(T0);
      expect(fetchTwap).not.toHaveBeenCalled();
      await svc.runSweep();
      expect(getSource).toHaveBeenCalledTimes(2);
      expect(entry(334)).toMatchObject({ exact: true, executedSz: 5 });
      await svc.runSweep();
      expect(getSource).toHaveBeenCalledTimes(2);
    });

    it('retries a failed /twaps/:id fetch of a discovered TWAP without reading the list again', async () => {
      running = [restRow(335, iso(T0 - MIN))];
      fetchTwap.mockRejectedValueOnce(new Error('503'));
      await connect(T0);
      fetchTwap.mockResolvedValue(detail(1, 5, 500, iso(T0 - 1_000)));
      await svc.runSweep();
      expect(entry(335)).toMatchObject({ exact: true });
      expect(getSource).toHaveBeenCalledTimes(1);
    });

    it('seeds book entries on later sweeps without the list: non-exact, past the boundary rule, not spot, not empty', async () => {
      await connect(T0);
      expect(fetchTwap).not.toHaveBeenCalled();
      client.statuses([
        status(336, { startTime: T0 - MIN }),
        status(337, { startTime: T0 - MIN, coin: '@107' }),
        status(338, { startTime: T0 + 6_000 }),
      ]);
      client.fills([fill(336, T0 + 7_000)]);
      await svc.runSweep();
      expect(fetchTwap.mock.calls.map((call) => call[0])).toEqual([336]);
      expect(getSource).toHaveBeenCalledTimes(1);
    });

    describe('cooldown and hourly cap', () => {
      it('waits for the 10 minutes after the last discovery when the socket reconnects sooner, entries staying non-exact', async () => {
        running = [restRow(340, iso(T0 - MIN))];
        fetchTwap.mockResolvedValue(detail(1, 5, 500, iso(T0 - 1_000)));
        await connect(T0);
        expect(getSource).toHaveBeenCalledTimes(1);
        expect(entry(340)?.exact).toBe(true);

        client.setConnected(false, now + 1_000);
        now += 2 * MIN;
        client.setConnected(true, now);
        await settle();
        await svc.runSweep();
        expect(getSource).toHaveBeenCalledTimes(1);
        expect(fetchTwap).toHaveBeenCalledTimes(1);
        expect(entry(340)?.exact).toBe(false);

        now += 7 * MIN; // 9 min after the discovery
        await svc.runSweep();
        expect(getSource).toHaveBeenCalledTimes(1);

        now += 2 * MIN; // 11 min
        await svc.runSweep();
        expect(getSource).toHaveBeenCalledTimes(2);
        expect(fetchTwap).toHaveBeenCalledTimes(2);
        expect(entry(340)?.exact).toBe(true);
      });

      it('runs the discovery right away when the last one is old enough', async () => {
        await connect(T0);
        client.setConnected(false, now + 1_000);
        now += 10 * MIN;
        client.setConnected(true, now);
        await settle();
        expect(getSource).toHaveBeenCalledTimes(2);
      });

      it('caps the /twaps/:id fetches at 3,000 per rolling hour across connections, logging once', async () => {
        running = Array.from({ length: 900 }, (_, i) => restRow(5_000 + i, iso(T0 - MIN)));
        await connect(T0);
        let total = fetchTwap.mock.calls.length;
        expect(total).toBe(800); // the per-connection cap

        const reconnect = async (): Promise<number> => {
          const before = fetchTwap.mock.calls.length;
          client.setConnected(false, now + 1_000);
          now += 10 * MIN;
          client.setConnected(true, now);
          await settle();
          return fetchTwap.mock.calls.length - before;
        };
        expect(await reconnect()).toBe(800);
        expect(await reconnect()).toBe(800);
        expect(await reconnect()).toBe(600); // 2,400 + 600 = 3,000
        expect(await reconnect()).toBe(0);
        expect(await reconnect()).toBe(0);
        const capLogs = (logDeduplicator.warn as jest.Mock).mock.calls.filter((call) => String(call[0]).includes('Hourly seeding cap'));
        expect(capLogs).toHaveLength(1); // once, however many sweeps ran into it
        total = fetchTwap.mock.calls.length;

        now += 31 * MIN; // the first fetches are more than an hour old
        expect(await reconnect()).toBeGreaterThan(0);
        expect(fetchTwap.mock.calls.length).toBeGreaterThan(total);
      }, 30_000);
    });

    describe('lost end events', () => {
      it('removes running entries missing from a complete REST list, and tells the clients that hold them', async () => {
        running = [restRow(350, iso(T0 - 20 * MIN))];
        client.setConnected(true, T0);
        listen();
        const old = { startTime: T0 - 20 * MIN };
        client.statuses([
          status(350, old), // still running in REST: kept
          status(351, old), // gone from REST, has fills: removed, clients told
          status(352, old), // gone from REST, never filled: removed silently
          status(353, { startTime: T0 - 30_000 }), // started within the 60 s margin: kept
          status(354, { ...old, status: 'finished', time: T0 + 2_000, executedSz: 1, executedNtl: 100 }), // terminal: kept
          status(355, { ...old, status: 'waitingForTrigger' }), // the list holds activated ones only: kept
        ]);
        client.fills([fill(351, T0 + 3_000), fill(350, T0 + 3_000)]);
        svc.flush();
        deltas.length = 0;
        await settle();

        expect(entry(351)).toBeUndefined();
        expect(entry(352)).toBeUndefined();
        for (const id of [350, 353, 354, 355]) expect(entry(id)).toBeDefined();
        svc.flush();
        expect(deltas[0].removed).toEqual([351]);
      });

      it('uses the deep rows too, and removes nothing when they could not be read', async () => {
        running = [restRow(360, iso(T0 - 20 * MIN))];
        deepRunning = [restRow(361, iso(T0 - 40 * MIN))];
        client.setConnected(true, T0);
        client.statuses([status(361, { startTime: T0 - 40 * MIN }), status(362, { startTime: T0 - 40 * MIN })]);
        await settle();
        expect(entry(361)).toBeDefined();
        expect(entry(362)).toBeUndefined();

        // Not complete: the first page is full but the deep walk has nothing yet.
        svc.stop();
        svc.start();
        deepRunning = null;
        getSource.mockImplementation(async () => ({ recent: [], running: [], deepAt: { recent: null, running: now }, updatedAt: now }) as never);
        client.setConnected(true, T0);
        client.statuses([status(363, { startTime: T0 - 40 * MIN })]);
        await settle();
        expect(entry(363)).toBeDefined();
        await svc.runSweep(); // retries the read, still incomplete
        expect(entry(363)).toBeDefined();
      });
    });
  });

  describe('REST meta', () => {
    it('applies a terminal meta as the entry\'s ended status, with its final totals', async () => {
      running = [restRow(370, iso(T0 - 20 * MIN))];
      fetchTwap.mockResolvedValue(
        payload(
          { twapId: 370, status: 'finished', executedSz: 30, executedNtl: 69_000, updatedAt: iso(T0 - 5_000).replace('000Z', '') },
          { fillCount: 93, totalNotional: 68_900, totalSz: 29.9, lastFill: iso(T0 - 6_000) }
        )
      );
      client.setConnected(true, T0);
      client.statuses([status(370, { startTime: T0 - 20 * MIN })]);
      client.fills([fill(370, T0 + 1_000, 1, 100)]);
      listen();
      await settle();
      expect(entry(370)).toMatchObject({
        status: 'finished', statusAt: T0 - 5_000, executedSz: 30, executedNtl: 69_000, fills: 93, exact: true, coin: 'BTC',
      });
      svc.flush();
      expect(deltas[0].entries[0]).toMatchObject({ twapId: 370, status: 'finished', executedSz: 30 });
      // Final: a late fill changes nothing.
      client.fills([fill(370, T0 + 2_000, 5, 100)]);
      expect(entry(370)).toMatchObject({ executedSz: 30, fills: 93 });
    });

    it('creates an ended entry the book never heard of, with its static fields from meta (UTC, address lowercased)', async () => {
      running = [restRow(371, iso(T0 - 20 * MIN))];
      const startTime = '2026-10-30T14:47:00';
      const updatedAt = '2026-10-30T14:47:00.244366';
      now = Date.parse(`${updatedAt}Z`) + 60_000;
      fetchTwap.mockResolvedValue(
        payload({ twapId: 371, status: 'terminated', executedSz: 12, executedNtl: 27_000, startTime, updatedAt }, { fillCount: 4, totalNotional: 1, totalSz: 1, lastFill: '2026-10-30T14:47:02.039000' })
      );
      await connect(now - 1_000);
      expect(entry(371)).toMatchObject({
        status: 'terminated', statusAt: Date.parse(`${updatedAt}Z`), executedSz: 12, executedNtl: 27_000, exact: true,
        coin: 'ETH', user: '0xabcdef0000000000000000000000000000000001', side: 'A', sz: 30, minutes: 60, reduceOnly: true,
        randomize: false, startTime: Date.parse(`${startTime}Z`),
      });
      expect(sent(371)).toBeDefined();
    });

    it('keeps the static fields the entry already has, and skips an ended TWAP too old to keep', async () => {
      running = [restRow(372, iso(T0 - 20 * MIN)), restRow(373, iso(T0 - 20 * MIN))];
      fetchTwap.mockImplementation(async (id: number) =>
        id === 372
          ? payload({ twapId: 372, status: 'stopped', coin: 'SOL', sz: 99, executedSz: 3, executedNtl: 300, updatedAt: iso(T0).replace('Z', '') })
          : payload({ twapId: 373, status: 'finished', executedSz: 3, executedNtl: 300, updatedAt: iso(now - 11 * MIN).replace('Z', '') })
      );
      client.setConnected(true, T0);
      client.statuses([status(372, { startTime: T0 - 20 * MIN })]);
      await settle();
      expect(entry(372)).toMatchObject({ status: 'stopped', coin: 'BTC', sz: 10, executedSz: 3 });
      expect(entry(373)).toBeUndefined();
    });

    it('still seeds progress from a live meta', async () => {
      running = [restRow(374, iso(T0 - 20 * MIN))];
      fetchTwap.mockResolvedValue(payload({ twapId: 374 }, { fillCount: 93, totalNotional: 38_944.03, totalSz: 17.3553, lastFill: iso(T0 - 1_000) }));
      await connect(T0);
      expect(entry(374)).toMatchObject({ exact: true, executedSz: 17.3553, executedNtl: 38_944.03, fills: 93 });
      expect(entry(374)?.status).toBeUndefined();
    });

    it('does not create an entry for a TWAP with no fill at all', async () => {
      running = [restRow(375, iso(T0 - 20 * MIN))];
      fetchTwap.mockResolvedValue(payload({ twapId: 375 }));
      await connect(T0);
      expect(entry(375)).toBeUndefined();
    });
  });

  describe('withholding never-filled entries', () => {
    it('keeps an entry out of the snapshot and the deltas until its first fill, then sends it whole', async () => {
      await connect(T0);
      listen();
      svc.flush();
      deltas.length = 0;

      client.statuses([status(380, { startTime: T0 + 6_000 })]);
      svc.flush();
      expect(entry(380)).toBeDefined();
      expect(sent(380)).toBeUndefined();
      expect(deltas.flatMap((d) => d.entries)).toEqual([]);
      expect(svc.getStats().withheld).toBe(1);

      client.fills([fill(380, T0 + 7_000, 1, 100)]);
      svc.flush();
      expect(sent(380)).toBeDefined();
      expect(deltas.flatMap((d) => d.entries)).toEqual([
        expect.objectContaining({ twapId: 380, status: 'activated', coin: 'BTC', startTime: T0 + 6_000, executedSz: 1, fills: 1 }),
      ]);
      expect(svc.getStats().withheld).toBe(0);
    });

    it('sends a TWAP cancelled before its first slice', async () => {
      await connect(T0);
      listen();
      svc.flush();
      deltas.length = 0;
      client.statuses([status(381, { startTime: T0 + 6_000 })]);
      client.statuses([status(381, { status: 'canceled', time: T0 + 8_000, startTime: T0 + 6_000 })]);
      svc.flush();
      expect(sent(381)).toMatchObject({ status: 'canceled' });
      expect(deltas.flatMap((d) => d.entries)).toEqual([expect.objectContaining({ twapId: 381, status: 'canceled' })]);
    });

    it('evicts a never-filled entry 2 minutes after its start, silently, and keeps a filled one', async () => {
      await connect(T0);
      listen();
      client.statuses([status(382, { startTime: T0 + 6_000, minutes: 60 }), status(383, { startTime: T0 + 6_000, minutes: 60 })]);
      client.fills([fill(383, T0 + 7_000)]);
      svc.flush();
      deltas.length = 0;

      now = T0 + 6_000 + 2 * MIN - 1;
      svc.flush();
      expect(entry(382)).toBeDefined();

      now = T0 + 6_000 + 2 * MIN + 6_000;
      svc.flush();
      expect(entry(382)).toBeUndefined();
      expect(entry(383)).toBeDefined();
      expect(deltas.flatMap((d) => d.removed)).toEqual([]); // 382 was never sent
    });

    it('tells the clients when it evicts an entry they had', async () => {
      await connect(T0);
      listen();
      client.statuses([status(384, { startTime: T0 + 6_000, minutes: 60 })]);
      client.fills([fill(384, T0 + 7_000)]);
      svc.flush();
      deltas.length = 0;
      // Lost to REST: removed with a notice (the 2 minute rule does not apply to a filled entry).
      now = T0 + 6_000 + 61 * MIN + 10 * MIN;
      svc.flush();
      expect(deltas[0].removed).toEqual([384]);
    });
  });

  describe('deltas', () => {
    it('sends a full entry for a new one or a status change, a patch for progress', async () => {
      await connect(T0);
      listen();
      svc.flush();
      deltas.length = 0;

      client.statuses([status(80, { startTime: T0 + 5_000 })]);
      client.fills([fill(80, T0 + 6_000, 1, 100), fill(81, T0 + 6_000, 1, 50)]); // 81: new, progress only
      svc.flush();
      expect(deltas).toHaveLength(1);
      const byId = new Map(deltas[0].entries.map((e) => [e.twapId, e]));
      expect(byId.get(80)).toMatchObject({ status: 'activated', coin: 'BTC', startTime: T0 + 5_000, executedSz: 1, exact: true });
      expect(Object.keys(byId.get(81) ?? {}).sort()).toEqual(['exact', 'executedNtl', 'executedSz', 'fills', 'lastFillAt', 'lastPx', 'twapId']);
      expect(deltas[0].removed).toEqual([]);

      deltas.length = 0;
      client.fills([fill(80, T0 + 7_000, 2, 100)]);
      svc.flush();
      expect(deltas[0].entries).toEqual([
        { twapId: 80, executedSz: 3, executedNtl: 300, fills: 2, lastFillAt: T0 + 7_000, lastPx: 100, exact: true },
      ]);

      deltas.length = 0;
      client.statuses([status(80, { status: 'finished', time: T0 + 9_000, executedSz: 30, executedNtl: 3_000, startTime: T0 + 5_000 })]);
      svc.flush();
      expect(deltas[0].entries[0]).toMatchObject({ twapId: 80, status: 'finished', statusAt: T0 + 9_000, executedSz: 30, coin: 'BTC' });
    });

    it('sends an upstream change alone as a delta with no entries', async () => {
      listen();
      svc.flush();
      deltas.length = 0;
      client.setConnected(true, T0);
      svc.flush();
      expect(deltas).toEqual([{ entries: [], removed: [], upstream: { connected: true, since: T0 }, at: now }]);
      svc.flush();
      expect(deltas).toHaveLength(1);
    });

    it('builds nothing while nobody listens, and a late listener starts from the snapshot', async () => {
      await connect(T0);
      expect(svc.hasListeners()).toBe(false);
      client.fills([fill(90, T0 + 6_000)]);
      svc.flush();
      listen();
      svc.flush();
      expect(deltas).toEqual([]);
      expect(entry(90)).toBeDefined();
      client.fills([fill(90, T0 + 7_000)]);
      svc.flush();
      expect(deltas).toHaveLength(1);
    });

    it('survives a throwing listener and unsubscribes', async () => {
      await connect(T0);
      const off = svc.onDelta(() => {
        throw new Error('boom');
      });
      listen();
      client.fills([fill(91, T0 + 6_000)]);
      svc.flush();
      expect(deltas).toHaveLength(1);
      off();
      expect(svc.hasListeners()).toBe(true);
    });
  });

  describe('eviction', () => {
    it('evicts ended entries 10 min after their end, running ones 10 min after start + minutes, idle progress-only ones after 30 min', async () => {
      await connect(T0);
      listen();
      client.statuses([
        status(100, { status: 'finished', time: T0 + 8_000, startTime: T0 + 5_000 }),
        status(101, { startTime: T0 + 2_000, minutes: 5 }),
      ]);
      client.fills([fill(101, T0 + 6_000), fill(102, T0 + 6_000)]);
      svc.flush();
      deltas.length = 0;

      now = T0 + 8_000 + 10 * MIN + 1;
      svc.flush();
      expect(deltas[0].removed).toEqual([100]);
      expect(entry(101)).toBeDefined();
      deltas.length = 0;

      now = T0 + 2_000 + 15 * MIN + 1;
      svc.flush();
      expect(deltas[0].removed).toEqual([101]);
      expect(entry(102)).toBeDefined();
      deltas.length = 0;

      now = T0 + 10_000 + 30 * MIN + 6_000; // past creation (T0 + 10 s) + 30 min
      svc.flush();
      expect(deltas[0].removed).toEqual([102]);
      expect(svc.getSnapshot().entries).toEqual([]);
    });

    it('keeps a progress-only entry alive while it fills', async () => {
      await connect(T0);
      client.fills([fill(103, T0 + 6_000)]);
      now = T0 + 25 * MIN;
      client.fills([fill(103, now - 1_000)]);
      now = T0 + 50 * MIN;
      svc.flush();
      expect(entry(103)).toBeDefined();
    });

    it('caps the book at 10,000 entries, oldest first', async () => {
      await connect(T0);
      listen();
      const batch: NormalizedFill[] = [];
      for (let i = 0; i < 10_050; i++) batch.push(fill(200_000 + i, T0 + 6_000));
      client.fills(batch);
      now += 6_000; // past the eviction interval
      svc.flush();
      expect(svc.getSnapshot().entries).toHaveLength(10_000);
      expect(entry(200_000)).toBeUndefined();
      expect(entry(200_049)).toBeUndefined();
      expect(entry(200_050)).toBeDefined();
      expect(deltas[0].removed).toHaveLength(50);
      expect(deltas[0].removed[0]).toBe(200_000);
    });
  });
});

function expectNoThrow(fn: () => void): void {
  expect(fn).not.toThrow();
}
