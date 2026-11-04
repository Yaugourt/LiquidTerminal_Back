/**
 * The live-data client runs sockets side by side and merges them: each fill
 * and status event once, and a drop counts as a disconnect only when no
 * socket left covers it.
 */
import type { NormalizedFill } from '../../../src/types/fill-alerts.types';
import type { TwapStatusEvent } from '../../../src/types/twap-live.types';
import type { WSConnectionState } from '../../../src/types/websocket.types';
import type { LiveDataSocketListener } from '../../../src/clients/hypedexer/websocket/live-data.socket';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/indexer/indexer-twaps.service', () => ({
  IndexerTwapsService: { getInstance: () => ({}) },
}));

import {
  HypeDexerLiveDataWSClient,
  LiveDataSocketHandle,
  liveDataSocketCount,
} from '../../../src/clients/hypedexer/websocket/live-data.ws.client';
import { RecentKeys } from '../../../src/utils/recent-keys';
import { TwapLiveService } from '../../../src/services/twap/twap-live.service';

const T0 = 1_800_000_000_000;
let now = T0;

class FakeSocket implements LiveDataSocketHandle {
  public started = 0;
  public stopped = 0;
  public state: WSConnectionState = 'disconnected';

  public constructor(
    public readonly slot: number,
    private readonly listener: LiveDataSocketListener,
  ) {}

  public start(): void {
    this.started++;
    this.state = 'connecting';
  }

  public stop(): void {
    this.stopped++;
    this.state = 'disconnected';
    this.listener.onReadyChange(false, now);
  }

  public getState(): WSConnectionState {
    return this.state;
  }

  public ready(): void {
    this.state = 'connected';
    this.listener.onReadyChange(true, now);
  }

  public drop(): void {
    this.state = 'reconnecting';
    this.listener.onReadyChange(false, now);
  }

  public fills(fills: NormalizedFill[]): void {
    this.listener.onFills(fills);
  }

  public statuses(events: TwapStatusEvent[]): void {
    this.listener.onTwapStatuses(events);
  }
}

function fill(tid: number, overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  return {
    source: 'perp',
    oid: 1,
    tid,
    wallet: '0xabc',
    coin: 'BTC',
    px: 100,
    sz: 1,
    notionalUsd: 100,
    side: 'B',
    time: now,
    hash: '0xhash',
    twapId: null,
    dir: 'Open Long',
    closedPnl: 0,
    ...overrides,
  };
}

function status(twapId: number, overrides: Partial<TwapStatusEvent> = {}): TwapStatusEvent {
  return {
    twapId,
    status: 'activated',
    time: T0,
    coin: 'BTC',
    user: '0xabc',
    side: 'B',
    sz: 10,
    executedSz: 0,
    executedNtl: 0,
    minutes: 30,
    reduceOnly: false,
    randomize: false,
    startTime: T0,
    isSnapshot: false,
    ...overrides,
  };
}

function setup(sockets = 2): {
  client: HypeDexerLiveDataWSClient;
  socket: FakeSocket[];
  fills: NormalizedFill[][];
  statuses: TwapStatusEvent[][];
  changes: Array<[boolean, number]>;
} {
  const socket: FakeSocket[] = [];
  const client = new HypeDexerLiveDataWSClient({
    sockets,
    now: () => now,
    createSocket: (slot, listener) => {
      const s = new FakeSocket(slot, listener);
      socket.push(s);
      return s;
    },
  });
  const fills: NormalizedFill[][] = [];
  const statuses: TwapStatusEvent[][] = [];
  const changes: Array<[boolean, number]> = [];
  client.onFill((f) => fills.push(f));
  client.onTwapStatus((e) => statuses.push(e));
  client.onConnectionChange((connected, at) => changes.push([connected, at]));
  client.start();
  return { client, socket, fills, statuses, changes };
}

beforeEach(() => {
  now = T0;
});

describe('HypeDexerLiveDataWSClient lifecycle', () => {
  it('opens every socket once however many consumers, and closes them with the last one', () => {
    const { client, socket } = setup();
    client.start(); // a second consumer joins

    expect(socket.map((s) => [s.slot, s.started])).toEqual([
      [1, 1],
      [2, 1],
    ]);

    client.stop();
    expect(socket.every((s) => s.stopped === 0)).toBe(true);
    expect(client.getStats().fillCallbackCount).toBe(1);

    client.stop();
    expect(socket.every((s) => s.stopped === 1)).toBe(true);
    expect(client.getStats()).toMatchObject({ fillCallbackCount: 0, twapStatusCallbackCount: 0, sockets: [] });
  });

  it('reports disconnected on the last stop, and ignores what a released socket still says', () => {
    const { client, socket, fills, changes } = setup();
    socket[0].ready();
    const listen: Array<[boolean, number]> = [];
    client.onConnectionChange((c, at) => listen.push([c, at]));

    client.stop();
    expect(listen).toEqual([[false, T0]]);
    expect(client.getConnection()).toEqual({ connected: false, at: null });

    // A late frame or state change from a socket the client let go of.
    socket[1].ready();
    socket[1].fills([fill(1)]);
    expect(fills).toEqual([]);
    expect(changes).toEqual([
      [true, T0],
      [false, T0],
    ]);
  });

  it('stops every socket even when one throws', () => {
    const { client, socket } = setup();
    socket[0].ready();
    jest.spyOn(socket[0], 'stop').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => client.stop()).not.toThrow();
    expect(socket[1].stopped).toBe(1);
    expect(client.getConnection()).toEqual({ connected: false, at: null });
  });

  it('starts fresh sockets after a full stop', () => {
    const { client, socket } = setup();
    client.stop();
    client.start();
    expect(socket).toHaveLength(4);
    expect(socket.slice(2).map((s) => s.started)).toEqual([1, 1]);
  });

  it('gives the overall state of its sockets', () => {
    const { client, socket } = setup();
    expect(client.getStats().state).toBe('connecting');
    socket[1].ready();
    expect(client.getStats()).toMatchObject({
      state: 'connected',
      sockets: [
        { slot: 1, state: 'connecting', ready: false },
        { slot: 2, state: 'connected', ready: true },
      ],
    });
  });
});

describe('HypeDexerLiveDataWSClient merging', () => {
  it('hands each fill over once, from whichever socket brings it first', () => {
    const { client, socket, fills } = setup();
    socket[0].ready();
    socket[1].ready();

    socket[0].fills([fill(1), fill(2)]);
    socket[1].fills([fill(1), fill(2), fill(3)]);
    socket[1].fills([fill(4)]);
    socket[0].fills([fill(3), fill(4)]); // all already handed over: no call at all

    expect(fills.map((batch) => batch.map((f) => f.tid))).toEqual([[1, 2], [3], [4]]);
    expect(client.getStats().duplicateFills).toBe(4);
  });

  it('tells fills apart by trade id, side and wallet', () => {
    const { socket, fills } = setup();
    socket[0].fills([fill(9), fill(9, { side: 'A' }), fill(9, { wallet: '0xdef' })]);
    socket[1].fills([fill(9), fill(9, { side: 'A' }), fill(9, { wallet: '0xdef' })]);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toHaveLength(3);
  });

  it('falls back to hash, time, side, wallet and size without a numeric trade id', () => {
    const { socket, fills } = setup();
    const noTid = fill(NaN, { hash: '0xh1' });
    socket[0].fills([noTid, { ...noTid, sz: 2 }]);
    socket[1].fills([{ ...noTid }, { ...noTid, sz: 2 }]);
    expect(fills.map((batch) => batch.length)).toEqual([2]);
  });

  it('keeps a fill id past the backlog of a stalled socket, and lets it go later', () => {
    const { socket, fills } = setup();
    socket[0].fills([fill(1)]);
    now += 50_000;
    socket[1].fills([fill(1)]); // the copy, 50 s late (a stall lasts ~40 s at most before the ping times out): dropped
    now += 11_000;
    socket[0].fills([fill(2)]); // rotates: fill 1 moves to the older generation
    now += 61_000;
    socket[0].fills([fill(3)]); // rotates again: fill 1 is forgotten
    socket[1].fills([fill(1)]);
    expect(fills.map((batch) => batch.map((f) => f.tid))).toEqual([[1], [2], [3], [1]]);
  });

  it('with one socket, hands everything over as it comes (no merging)', () => {
    const { client, socket, fills, statuses } = setup(1);
    expect(socket).toHaveLength(1);
    socket[0].fills([fill(1)]);
    socket[0].fills([fill(1)]);
    socket[0].statuses([status(5)]);
    socket[0].statuses([status(5)]);
    expect(fills).toHaveLength(2);
    expect(statuses).toHaveLength(2);
    expect(client.getStats().duplicateFills).toBe(0);
  });

  it('hands each status event over once, a later subscribe snapshot included', () => {
    const { client, socket, statuses } = setup();
    socket[0].statuses([status(5), status(6)]);
    socket[1].statuses([status(5), status(6)]);
    socket[0].statuses([status(5, { status: 'finished', time: T0 + 60_000 })]);

    // Socket 2 reconnects: its snapshot replays what socket 1 brought, and one event never seen.
    now += 10 * 60_000;
    socket[1].statuses([
      status(5, { isSnapshot: true }),
      status(5, { status: 'finished', time: T0 + 60_000, isSnapshot: true }),
      status(7, { isSnapshot: true }),
    ]);

    expect(statuses.map((batch) => batch.map((e) => `${e.twapId}:${e.status}`))).toEqual([
      ['5:activated', '6:activated'],
      ['5:finished'],
      ['7:activated'],
    ]);
    expect(statuses[2][0].isSnapshot).toBe(true);
    expect(client.getStats().duplicateStatuses).toBe(4);
  });

  it('survives throwing callbacks', () => {
    const { client, socket, fills } = setup();
    client.onFill(() => {
      throw new Error('boom');
    });
    client.onTwapStatus(() => {
      throw new Error('boom');
    });
    client.onConnectionChange(() => {
      throw new Error('boom');
    });
    expect(() => socket[0].ready()).not.toThrow();
    expect(() => socket[0].fills([fill(1)])).not.toThrow();
    expect(() => socket[0].statuses([status(1)])).not.toThrow();
    expect(fills).toHaveLength(1);
  });
});

describe('HypeDexerLiveDataWSClient connection', () => {
  /** Both sockets ready, both receiving since T0 + 1 s; the clock at T0 + 60 s. */
  function streaming(): ReturnType<typeof setup> {
    const ctx = setup();
    ctx.socket[0].ready();
    now += 500;
    ctx.socket[1].ready();
    now = T0 + 1_000;
    ctx.socket[0].fills([fill(1)]);
    ctx.socket[1].fills([fill(1)]);
    now = T0 + 60_000;
    ctx.socket[0].fills([fill(2)]);
    ctx.socket[1].fills([fill(2)]);
    return ctx;
  }

  it('connects with the first ready socket; another one joining changes nothing', () => {
    const { client, changes } = streaming();
    expect(changes).toEqual([[true, T0]]);
    expect(client.getConnection()).toEqual({ connected: true, at: T0 });
  });

  it('stays connected when a socket drops while another one streams, and when it comes back', () => {
    const { client, socket, changes } = streaming();
    now += 100;
    socket[0].drop();
    now += 5_000;
    socket[0].ready();
    now += 1_000;
    socket[1].drop(); // socket 1 is back but has received nothing yet ...
    expect(changes).toEqual([
      [true, T0],
      [false, T0 + 66_100],
      [true, T0 + 66_100],
    ]); // ... so that second drop may be a gap: the connection starts over
    expect(client.getStats()).toMatchObject({ handovers: 1, gaps: 1 });
  });

  it('counts a handover only when the other socket received from before the last fills of the dropped one', () => {
    const { client, socket, changes } = setup();
    socket[0].ready();
    socket[1].ready();
    now = T0 + 10_000;
    socket[0].fills([fill(1)]);
    now = T0 + 11_000;
    socket[1].fills([fill(1)]); // first fills on socket 2, 1 s before socket 1's last
    socket[0].fills([fill(2)]);
    socket[0].drop();
    expect(changes).toEqual([
      [true, T0],
      [false, T0 + 11_000],
      [true, T0 + 11_000],
    ]);
    expect(client.getConnection()).toEqual({ connected: true, at: T0 + 11_000 });

    // Two seconds of overlap is enough.
    now = T0 + 20_000;
    socket[0].ready();
    socket[0].fills([fill(3)]);
    now = T0 + 22_000;
    socket[1].fills([fill(4)]);
    socket[1].drop();
    expect(changes).toHaveLength(3);
    expect(client.getStats()).toMatchObject({ handovers: 1, gaps: 1 });
  });

  it('a socket that drops before its first fills leaves the connection alone while another one is up', () => {
    const { socket, changes } = setup();
    socket[0].ready();
    socket[1].ready();
    now += 1_000;
    socket[0].drop();
    expect(changes).toEqual([[true, T0]]);
  });

  it('disconnects when the last ready socket drops, and reconnects with the next one', () => {
    const { client, socket, changes } = streaming();
    socket[0].drop();
    now += 1_000;
    socket[1].drop();
    expect(client.getConnection()).toEqual({ connected: false, at: null });
    now += 5_000;
    socket[1].ready();
    expect(changes).toEqual([
      [true, T0],
      [false, T0 + 61_000],
      [true, T0 + 66_000],
    ]);
  });

  it('with one socket, a drop is a disconnect as before', () => {
    const { socket, changes } = setup(1);
    socket[0].ready();
    now += 1_000;
    socket[0].fills([fill(1)]);
    socket[0].drop();
    expect(changes).toEqual([
      [true, T0],
      [false, T0 + 1_000],
    ]);
  });
});

describe('HypeDexerLiveDataWSClient silent stalls', () => {
  /** Both ready at T0, both receiving from T0 + 1 s; socket 2 receives for the last time at `lastOn2`, socket 1 at T0 + 20 s, then drops. */
  function dropAfterStall(lastOn2: number): Array<[boolean, number]> {
    const { socket, changes } = setup();
    socket[0].ready();
    socket[1].ready();
    now = T0 + 1_000;
    socket[0].fills([fill(1)]);
    socket[1].fills([fill(1)]);
    now = lastOn2;
    socket[1].fills([fill(2)]);
    socket[0].fills([fill(2)]);
    now = T0 + 20_000;
    socket[0].fills([fill(3)]);
    socket[0].drop();
    return changes;
  }

  it('a socket that stopped receiving more than 5 s before the dropped one is no cover', () => {
    expect(dropAfterStall(T0 + 10_000)).toEqual([
      [true, T0],
      [false, T0 + 20_000],
      [true, T0 + 20_000],
    ]);
  });

  it('a socket that received up to 5 s before the dropped one still covers it', () => {
    expect(dropAfterStall(T0 + 15_000)).toEqual([[true, T0]]);
  });
});

describe('HypeDexerLiveDataWSClient with the live TWAP book', () => {
  it('a covered drop leaves the book connected and exact; a possible gap restarts it', () => {
    const { client, socket } = setup();
    const book = new TwapLiveService({
      client,
      now: () => now,
      seedGapMs: 0,
      fetchTwap: async () => ({}),
      source: {
        getTwapSource: async () => ({ running: [], deepAt: { recent: null, running: null } }) as never,
        getTwapSourceDeep: async () => ({ running: null }) as never,
      },
    });
    book.start();
    socket[0].ready();
    now = T0 + 1_000;
    socket[1].ready();

    // A TWAP that starts 10 s into the connection: exact from its activation, its slices through both sockets.
    now = T0 + 10_000;
    for (const s of socket) s.statuses([status(42, { time: now, startTime: now })]);
    for (const s of socket) s.fills([fill(1, { twapId: 42, sz: 2 })]);
    now = T0 + 40_000;
    for (const s of socket) s.fills([fill(2, { twapId: 42, sz: 2 })]);
    expect(book.peek(42)).toMatchObject({ exact: true, fills: 2, executedSz: 4 });

    // Socket 1 drops: socket 2 covers it, the book does not notice.
    now = T0 + 40_100;
    socket[0].drop();
    expect(book.getStats().connectedSince).toBe(T0);
    expect(book.peek(42)).toMatchObject({ exact: true, executedSz: 4 });

    // Socket 1 is back but has received nothing when socket 2 drops: a possible gap.
    now = T0 + 46_000;
    socket[0].ready();
    now = T0 + 47_000;
    socket[1].drop();
    expect(book.getStats().connectedSince).toBe(T0 + 47_000);
    expect(book.peek(42)?.exact).toBe(false);

    book.stop();
    client.stop();
  });
});

describe('liveDataSocketCount', () => {
  it('reads HYPEDEXER_LIVEDATA_SOCKETS: 1 to 3, else 2', () => {
    expect(liveDataSocketCount(undefined)).toBe(2);
    expect(liveDataSocketCount('')).toBe(2);
    expect(liveDataSocketCount('1')).toBe(1);
    expect(liveDataSocketCount('3')).toBe(3);
    expect(liveDataSocketCount('5')).toBe(3);
    expect(liveDataSocketCount('0')).toBe(2);
    expect(liveDataSocketCount('2.5')).toBe(2);
    expect(liveDataSocketCount('two')).toBe(2);
  });
});

describe('RecentKeys', () => {
  it('remembers a key at least one period, and forgets it after two rotations', () => {
    const keys = new RecentKeys(1_000, 100, 0);
    expect(keys.add('a', 0)).toBe(true);
    expect(keys.add('a', 999)).toBe(false);
    expect(keys.add('b', 1_000)).toBe(true); // rotation: 'a' is in the older generation
    expect(keys.add('a', 1_500)).toBe(false);
    expect(keys.add('c', 2_000)).toBe(true); // rotation: 'a' is dropped
    expect(keys.add('a', 2_001)).toBe(true);
  });

  it('rotates early when a generation is full', () => {
    const keys = new RecentKeys(60_000, 2, 0);
    keys.add('a', 0);
    keys.add('b', 0);
    keys.add('c', 0); // full: rotation, {a, b} older
    keys.add('d', 0);
    keys.add('e', 0); // full again: {a, b} dropped, {c, d} older
    expect(keys.add('d', 0)).toBe(false);
    expect(keys.add('a', 0)).toBe(true);
    expect(keys.size).toBeLessThanOrEqual(4);
  });

  it('clear forgets everything', () => {
    const keys = new RecentKeys(1_000, 100, 0);
    keys.add('a', 0);
    keys.clear(10);
    expect(keys.size).toBe(0);
    expect(keys.add('a', 10)).toBe(true);
  });
});
