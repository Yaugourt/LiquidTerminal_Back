/**
 * HypeDexer's `allFills` carries every fill since `fills_spot` was dropped:
 * spot pairs ("@107", "PURR/USDC") must come out as spot fills, every other
 * market (native, HIP-3 "dex:COIN", HIP-4 "#N") as perp fills, as before.
 */
import type { HypeDexerFill, NormalizedFill } from '../../../src/types/fill-alerts.types';
import type { TwapStatusEvent } from '../../../src/types/twap-live.types';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logDeduplicator } from '../../../src/utils/logDeduplicator';
import { HypeDexerLiveDataSocket, LiveDataSocketListener } from '../../../src/clients/hypedexer/websocket/live-data.socket';

/** A socket that never connects, its listener recording what it hands over. */
function makeSocket(overrides: Partial<LiveDataSocketListener> = {}): {
  socket: HypeDexerLiveDataSocket;
  fills: NormalizedFill[];
  statuses: TwapStatusEvent[];
  readiness: Array<[boolean, number]>;
  deliver(event: unknown): void;
} {
  const fills: NormalizedFill[] = [];
  const statuses: TwapStatusEvent[] = [];
  const readiness: Array<[boolean, number]> = [];
  const socket = new HypeDexerLiveDataSocket(
    1,
    {
      onFills: (f) => fills.push(...f),
      onTwapStatuses: (e) => statuses.push(...e),
      onReadyChange: (ready, at) => readiness.push([ready, at]),
      ...overrides,
    },
    { url: 'wss://example.invalid/ws', apiKey: 'test' },
  );
  const deliver = (event: unknown): void => (socket as unknown as { onMessage(data: unknown): void }).onMessage(event);
  return { socket, fills, statuses, readiness, deliver };
}

function fill(coin: string, overrides: Partial<HypeDexerFill> = {}): HypeDexerFill {
  return {
    coin,
    px: '2.5',
    sz: '4',
    side: 'B',
    time: 1_790_287_319_157,
    startPosition: '0.0',
    dir: 'Open Long',
    closedPnl: '1.25',
    hash: '0xhash',
    oid: 42,
    crossed: true,
    fee: '0.01',
    tid: 7,
    feeToken: 'USDC',
    twapId: null,
    ...overrides,
  };
}

describe('HypeDexerLiveDataSocket allFills normalization', () => {
  const { fills: received, deliver } = makeSocket();

  beforeEach(() => {
    received.length = 0;
  });

  it('tells spot fills apart from perp-like fills', () => {
    deliver({
      channel: 'allFills',
      data: {
        fills: [
          { address: '0xAAA', fill: fill('BTC') },
          { address: '0xBBB', fill: fill('xyz:GOLD', { dir: 'Close Short', closedPnl: 'oops' }) },
          { address: '0xCCC', fill: fill('#45931', { dir: 'Buy' }) },
          { address: '0xDDD', fill: fill('@107', { dir: 'Sell', side: 'A', twapId: 99 }) },
          { address: '0xEEE', fill: fill('PURR/USDC', { dir: 'Buy' }) },
        ],
      },
    });

    const common = { oid: 42, tid: 7, px: 2.5, sz: 4, notionalUsd: 10, time: 1_790_287_319_157, hash: '0xhash' };
    expect(received).toEqual([
      { source: 'perp', ...common, wallet: '0xaaa', coin: 'BTC', side: 'B', twapId: null, dir: 'Open Long', closedPnl: 1.25 },
      { source: 'perp', ...common, wallet: '0xbbb', coin: 'xyz:GOLD', side: 'B', twapId: null, dir: 'Close Short', closedPnl: 0 },
      { source: 'perp', ...common, wallet: '0xccc', coin: '#45931', side: 'B', twapId: null, dir: 'Buy', closedPnl: 1.25 },
      // Spot: no direction and no realized PnL on alerts; the pair id is resolved by the dispatcher.
      { source: 'spot', ...common, wallet: '0xddd', coin: '@107', side: 'A', twapId: 99 },
      { source: 'spot', ...common, wallet: '0xeee', coin: 'PURR/USDC', side: 'B', twapId: null },
    ]);
  });

  it('skips the snapshot replayed on subscribe', () => {
    deliver({ channel: 'allFills', data: { isSnapshot: true, fills: [{ address: '0xAAA', fill: fill('@107') }] } });
    expect(received).toEqual([]);
  });
});

function twapEvent(overrides: Record<string, unknown> = {}, state: Record<string, unknown> = {}): unknown {
  return {
    state: {
      coin: 'NEAR',
      executedNtl: '171990.41044',
      executedSz: '39238.6',
      minutes: 30,
      randomize: true,
      reduceOnly: true,
      side: 'B',
      stopPx: null,
      sz: '141882.5',
      timestamp: 1_793_373_016_110,
      trigger: null,
      user: '0x3BCAE23E8C380DAB4732E9A159C0456F12D866F3',
      ...state,
    },
    status: 'terminated',
    time: 1_793_373_527_906,
    twapId: 2_456_268,
    ...overrides,
  };
}

describe('HypeDexerLiveDataSocket allTwapStatusUpdates', () => {
  const { fills, statuses: received, deliver } = makeSocket();
  const warn = logDeduplicator.warn as jest.Mock;

  beforeEach(() => {
    received.length = 0;
    fills.length = 0;
    warn.mockClear();
  });

  const parsed = {
    twapId: 2_456_268,
    status: 'terminated',
    time: 1_793_373_527_906,
    coin: 'NEAR',
    user: '0x3bcae23e8c380dab4732e9a159c0456f12d866f3',
    side: 'B',
    sz: 141_882.5,
    executedSz: 39_238.6,
    executedNtl: 171_990.41044,
    minutes: 30,
    reduceOnly: true,
    randomize: true,
    startTime: 1_793_373_016_110,
  };

  it('parses a live frame (data is an array)', () => {
    deliver({ channel: 'allTwapStatusUpdates', data: [twapEvent()] });
    expect(received).toEqual([{ ...parsed, isSnapshot: false }]);
    expect(warn).not.toHaveBeenCalled(); // not an unknown channel
  });

  it('parses the snapshot frame and flags its events', () => {
    deliver({
      channel: 'allTwapStatusUpdates',
      data: { isSnapshot: true, events: [twapEvent(), twapEvent({ twapId: 5, status: 'activated' }, { executedSz: '0', executedNtl: '0' })] },
    });
    expect(received).toHaveLength(2);
    expect(received.every((e) => e.isSnapshot)).toBe(true);
    expect(received[1]).toMatchObject({ twapId: 5, status: 'activated', executedSz: 0, executedNtl: 0 });
  });

  it('keeps an unknown status string and a trigger TWAP', () => {
    deliver({
      channel: 'allTwapStatusUpdates',
      data: [twapEvent({ status: 'waitingForTrigger' }, { stopPx: '1.5', trigger: { above: true, px: '1.5' } })],
    });
    expect(received[0].status).toBe('waitingForTrigger');
  });

  it('drops malformed events with one warning and keeps the valid ones', () => {
    deliver({
      channel: 'allTwapStatusUpdates',
      data: [
        twapEvent({ twapId: 'abc' }),
        twapEvent({}, { sz: 'NaN' }),
        twapEvent({}, { side: 'X' }),
        twapEvent({ status: 12 }),
        { twapId: 1, status: 'activated', time: 1 },
        null,
        'oops',
        twapEvent({ twapId: 77 }),
      ],
    });
    expect(received.map((e) => e.twapId)).toEqual([77]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'), { count: 7 });
  });

  it('ignores an empty or unusable payload', () => {
    deliver({ channel: 'allTwapStatusUpdates', data: [] });
    deliver({ channel: 'allTwapStatusUpdates', data: { isSnapshot: true } });
    deliver({ channel: 'allTwapStatusUpdates' });
    expect(received).toEqual([]);
  });

  it('survives a throwing listener', () => {
    const throwing = makeSocket({
      onTwapStatuses: () => {
        throw new Error('boom');
      },
      onFills: () => {
        throw new Error('boom');
      },
    });
    expect(() => throwing.deliver({ channel: 'allTwapStatusUpdates', data: [twapEvent()] })).not.toThrow();
    expect(() => throwing.deliver({ channel: 'allFills', data: { fills: [{ address: '0xA', fill: fill('BTC') }] } })).not.toThrow();
  });

  it('keeps allFills snapshots skipped and never shows status traffic to fill consumers', () => {
    deliver({ channel: 'allTwapStatusUpdates', data: [twapEvent()] });
    deliver({ channel: 'allFills', data: { isSnapshot: true, fills: [{ address: '0xA', fill: fill('BTC') }] } });
    expect(fills).toEqual([]);
  });

  it('carries the trade id on fills', () => {
    deliver({ channel: 'allFills', data: { fills: [{ address: '0xA', fill: fill('BTC', { tid: 99, twapId: 5 }) }] } });
    expect(fills[0]).toMatchObject({ tid: 99, twapId: 5 });
  });
});

describe('HypeDexerLiveDataSocket lifecycle', () => {
  type Internals = {
    onOpen(): void;
    handleStateChange(state: string): void;
    logName: string;
  };

  afterEach(() => jest.restoreAllMocks());

  it('subscribes to both channels on open and reports ready once both are sent', () => {
    const { socket, readiness } = makeSocket();
    const send = jest.spyOn(socket, 'send').mockReturnValue(true);
    const internals = socket as unknown as Internals;

    internals.onOpen();

    expect(send).toHaveBeenCalledWith({ method: 'subscribe', subscription: { type: 'allFills' } });
    expect(send).toHaveBeenCalledWith({ method: 'subscribe', subscription: { type: 'allTwapStatusUpdates' } });
    expect(readiness.map((r) => r[0])).toEqual([true]);
    expect(socket.isReady()).toBe(true);

    // 'connected' alone changes nothing; anything else is a drop.
    internals.handleStateChange('connected');
    expect(readiness).toHaveLength(1);
    internals.handleStateChange('reconnecting');
    expect(readiness.map((r) => r[0])).toEqual([true, false]);
    expect(socket.isReady()).toBe(false);
    // No repeat while already down.
    internals.handleStateChange('error');
    expect(readiness).toHaveLength(2);
  });

  it('is not ready when a subscription could not be sent', () => {
    const { socket, readiness } = makeSocket();
    jest.spyOn(socket, 'send').mockReturnValueOnce(true).mockReturnValueOnce(false);
    (socket as unknown as Internals).onOpen();
    expect(readiness).toEqual([]);
    expect(socket.isReady()).toBe(false);
  });

  it('survives a throwing ready listener', () => {
    const { socket } = makeSocket({
      onReadyChange: () => {
        throw new Error('boom');
      },
    });
    jest.spyOn(socket, 'send').mockReturnValue(true);
    expect(() => (socket as unknown as Internals).onOpen()).not.toThrow();
  });

  it('start connects, stop disconnects and reports not ready', () => {
    const { socket, readiness } = makeSocket();
    const connect = jest.spyOn(socket, 'connect').mockImplementation(() => undefined);
    const disconnect = jest.spyOn(socket, 'disconnect').mockImplementation(() => undefined);
    jest.spyOn(socket, 'send').mockReturnValue(true);

    socket.start();
    expect(connect).toHaveBeenCalledTimes(1);
    (socket as unknown as Internals).onOpen();
    socket.stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(readiness.map((r) => r[0])).toEqual([true, false]);
  });

  it('names its log lines after the client, with its number', () => {
    const { socket } = makeSocket();
    expect((socket as unknown as Internals).logName).toBe('HypeDexerLiveDataWSClient#1');
  });
});
