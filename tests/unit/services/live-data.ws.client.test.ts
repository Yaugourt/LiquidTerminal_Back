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
import { HypeDexerLiveDataWSClient } from '../../../src/clients/hypedexer/websocket/live-data.ws.client';

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

describe('HypeDexerLiveDataWSClient allFills normalization', () => {
  const client = HypeDexerLiveDataWSClient.getInstance();
  const received: NormalizedFill[] = [];
  const unsubscribe = client.onFill((fills) => received.push(...fills));
  const deliver = (event: unknown): void =>
    (client as unknown as { onMessage(data: unknown): void }).onMessage(event);

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(() => unsubscribe());

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

describe('HypeDexerLiveDataWSClient allTwapStatusUpdates', () => {
  const client = HypeDexerLiveDataWSClient.getInstance();
  const received: TwapStatusEvent[] = [];
  const unsubscribe = client.onTwapStatus((events) => received.push(...events));
  const deliver = (event: unknown): void =>
    (client as unknown as { onMessage(data: unknown): void }).onMessage(event);
  const warn = logDeduplicator.warn as jest.Mock;

  beforeEach(() => {
    received.length = 0;
    warn.mockClear();
  });

  afterAll(() => unsubscribe());

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

  it('survives a throwing callback', () => {
    const off = client.onTwapStatus(() => {
      throw new Error('boom');
    });
    deliver({ channel: 'allTwapStatusUpdates', data: [twapEvent()] });
    expect(received).toHaveLength(1);
    off();
  });

  it('keeps allFills snapshots skipped and never shows status traffic to fill consumers', () => {
    const fills: NormalizedFill[] = [];
    const off = client.onFill((f) => fills.push(...f));
    deliver({ channel: 'allTwapStatusUpdates', data: [twapEvent()] });
    deliver({ channel: 'allFills', data: { isSnapshot: true, fills: [{ address: '0xA', fill: fill('BTC') }] } });
    expect(fills).toEqual([]);
    off();
  });

  it('carries the trade id on fills', () => {
    const fills: NormalizedFill[] = [];
    const off = client.onFill((f) => fills.push(...f));
    deliver({ channel: 'allFills', data: { fills: [{ address: '0xA', fill: fill('BTC', { tid: 99, twapId: 5 }) }] } });
    expect(fills[0]).toMatchObject({ tid: 99, twapId: 5 });
    off();
  });
});

describe('HypeDexerLiveDataWSClient lifecycle', () => {
  type Internals = {
    onOpen(): void;
    handleStateChange(state: string): void;
    setUpstreamConnected(connected: boolean): void;
  };
  const client = HypeDexerLiveDataWSClient.getInstance();
  const internals = client as unknown as Internals;
  let connect: jest.SpyInstance;
  let disconnect: jest.SpyInstance;
  let send: jest.SpyInstance;

  beforeEach(() => {
    connect = jest.spyOn(client, 'connect').mockImplementation(() => undefined);
    disconnect = jest.spyOn(client, 'disconnect').mockImplementation(() => undefined);
    send = jest.spyOn(client, 'send').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Back to a clean slate for the next test (the singleton is shared).
    client.stop();
    client.stop();
  });

  it('subscribes to both channels on open and reports connected once both are sent', () => {
    const changes: Array<[boolean, number]> = [];
    const off = client.onConnectionChange((connected, at) => changes.push([connected, at]));

    internals.onOpen();

    expect(send).toHaveBeenCalledWith({ method: 'subscribe', subscription: { type: 'allFills' } });
    expect(send).toHaveBeenCalledWith({ method: 'subscribe', subscription: { type: 'allTwapStatusUpdates' } });
    expect(changes).toHaveLength(1);
    expect(changes[0][0]).toBe(true);
    expect(client.getConnection()).toEqual({ connected: true, at: changes[0][1] });

    // 'connected' alone changes nothing; anything else is a disconnect.
    internals.handleStateChange('connected');
    expect(changes).toHaveLength(1);
    internals.handleStateChange('reconnecting');
    expect(changes.map((c) => c[0])).toEqual([true, false]);
    expect(client.getConnection()).toEqual({ connected: false, at: null });
    // No repeat while already down.
    internals.handleStateChange('error');
    expect(changes).toHaveLength(2);
    off();
  });

  it('is not connected when a subscription could not be sent', () => {
    send.mockReturnValueOnce(true).mockReturnValueOnce(false);
    internals.onOpen();
    expect(client.getConnection().connected).toBe(false);
  });

  it('survives a throwing connection callback', () => {
    const off = client.onConnectionChange(() => {
      throw new Error('boom');
    });
    expect(() => internals.onOpen()).not.toThrow();
    off();
  });

  it('closes the socket with the last consumer only, and drops every callback then', () => {
    const fills: NormalizedFill[] = [];
    const statuses: TwapStatusEvent[] = [];
    client.onFill((f) => fills.push(...f));
    client.onTwapStatus((e) => statuses.push(...e));

    client.start(); // consumer A (e.g. the fill-alert dispatcher)
    client.start(); // consumer B (the live TWAP book)
    expect(connect).toHaveBeenCalledTimes(1);

    client.stop();
    expect(disconnect).not.toHaveBeenCalled();
    expect(client.getStats().fillCallbackCount).toBe(1);

    client.stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(client.getStats()).toMatchObject({ fillCallbackCount: 0, twapStatusCallbackCount: 0 });
  });

  it('keeps single-consumer behavior: stop closes and clears', () => {
    client.onFill(() => undefined);
    client.start();
    client.stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(client.getStats().fillCallbackCount).toBe(0);
  });
});
