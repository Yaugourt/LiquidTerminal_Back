/**
 * Hyperliquid weight meter: every request sent to api(-ui).hyperliquid.xyz/info
 * is counted with the documented weight of its type, one summary a minute, the
 * last minute's total kept for /api/health. HypeDexer's own /info is not.
 */
const info = jest.fn();
const warn = jest.fn();
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: (...a: unknown[]) => info(...a), warn: (...a: unknown[]) => warn(...a), error: jest.fn(), debug: jest.fn() },
}));

import {
  hyperliquidWeight,
  hyperliquidWeightMeter,
  HyperliquidWeightMeter,
  infoRequestType,
} from '../../../src/utils/hyperliquid-weight-meter';
import { BaseApiService } from '../../../src/core/base.api.service';
import { HypeDexerInfoClient } from '../../../src/clients/hypedexer/rest/info/info.client';

describe('weights', () => {
  it.each([
    ['l2Book', 2],
    ['allMids', 2],
    ['clearinghouseState', 2],
    ['orderStatus', 2],
    ['spotClearinghouseState', 2],
    ['exchangeStatus', 2],
    ['userRole', 60],
    ['metaAndAssetCtxs', 20],
    ['spotMetaAndAssetCtxs', 20],
    ['tokenDetails', 20],
    ['globalStats', 20],
    ['validatorSummaries', 20],
    ['vaultDetails', 20],
    ['userFillsByTime', 20],
    ['somethingNew', 20],
  ])('%s weighs %i', (type, weight) => {
    expect(hyperliquidWeight(type)).toBe(weight);
  });

  it('reads the type of a request body', () => {
    expect(infoRequestType(JSON.stringify({ type: 'clearinghouseState', user: '0x1' }))).toBe('clearinghouseState');
    expect(infoRequestType('{"type" : "allMids"}')).toBe('allMids');
    expect(infoRequestType(undefined)).toBeUndefined();
    expect(infoRequestType('not json')).toBeUndefined();
    expect(infoRequestType(42)).toBeUndefined();
  });
});

describe('HyperliquidWeightMeter', () => {
  let meter: HyperliquidWeightMeter;
  beforeEach(() => {
    info.mockClear();
    warn.mockClear();
    meter = new HyperliquidWeightMeter();
  });
  afterEach(() => meter.reset());

  it('sums the minute by type and logs the top types', () => {
    meter.record(JSON.stringify({ type: 'metaAndAssetCtxs' }));
    meter.record(JSON.stringify({ type: 'metaAndAssetCtxs' }));
    meter.record(JSON.stringify({ type: 'clearinghouseState', user: '0x1' }));
    meter.record('allMids');
    meter.flush();
    expect(meter.lastMinute()).toMatchObject({ weight: 20 + 20 + 2 + 2, calls: 4 });
    expect(info).toHaveBeenCalledWith(
      'Hyperliquid weight (last minute)',
      expect.objectContaining({ weight: 44, calls: 4, topTypes: ['metaAndAssetCtxs 40/2', 'clearinghouseState 2/1', 'allMids 2/1'] })
    );
  });

  it('counts a request whose type it cannot read at the default weight', () => {
    meter.record('{garbage');
    meter.record(undefined);
    meter.flush();
    expect(meter.lastMinute()).toMatchObject({ weight: 40, calls: 2 });
  });

  it('adds the per-item extra only for the types that have one', () => {
    meter.record('userFillsByTime');
    meter.recordItems('userFillsByTime', new Array(105).fill({}));
    meter.record('candleSnapshot');
    meter.recordItems('candleSnapshot', new Array(130).fill({}));
    meter.record('tokenDetails');
    meter.recordItems('tokenDetails', new Array(500).fill({}));
    meter.recordItems('userFillsByTime', { not: 'an array' });
    meter.flush();
    // 20 + 5, 20 + 2, 20 + 0
    expect(meter.lastMinute()).toMatchObject({ weight: 25 + 22 + 20, calls: 3 });
  });

  it('warns when a minute gets close to the limit and starts the next from zero', () => {
    for (let i = 0; i < 50; i++) meter.record('metaAndAssetCtxs');
    meter.flush();
    expect(warn).toHaveBeenCalledWith('Hyperliquid weight (last minute) near the 1,200 limit', expect.objectContaining({ weight: 1000 }));
    meter.flush();
    expect(meter.lastMinute()).toMatchObject({ weight: 0, calls: 0 });
  });

  it('logs nothing for a minute without requests, and has no minute before the first flush', () => {
    expect(meter.lastMinute()).toBeNull();
    meter.flush();
    expect(info).not.toHaveBeenCalled();
    expect(meter.lastMinute()).toMatchObject({ weight: 0 });
  });

  it('keeps the number of distinct types bounded', () => {
    for (let i = 0; i < 200; i++) meter.record(`type${i}`);
    meter.flush();
    expect(meter.lastMinute()).toMatchObject({ weight: 200 * 20, calls: 200 });
    const fields = warn.mock.calls[0][1] as { topTypes: string[] };
    expect(fields.topTypes.length).toBeLessThanOrEqual(8);
  });

  it('never throws, whatever it is given', () => {
    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(() => meter.record(hostile)).not.toThrow();
    expect(() => meter.recordItems('userFills', hostile)).not.toThrow();
    expect(() => meter.recordItems(undefined, null)).not.toThrow();
    info.mockImplementation(() => {
      throw new Error('logger down');
    });
    meter.record('allMids');
    expect(() => meter.flush()).not.toThrow();
    info.mockReset();
  });
});

describe('requests sent through BaseApiService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  class HlClient extends BaseApiService {
    constructor(base: string) {
      super(base);
    }
    read<T>(body: Record<string, unknown>): Promise<T> {
      return this.post<T>('', body);
    }
  }
  const reply = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    hyperliquidWeightMeter.reset();
    fetchMock = jest.fn(async () => reply([]));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => hyperliquidWeightMeter.reset());
  afterAll(() => {
    global.fetch = realFetch;
  });

  const spent = (): { weight: number; calls: number } => {
    hyperliquidWeightMeter.flush();
    return hyperliquidWeightMeter.lastMinute() ?? { weight: -1, calls: -1 };
  };

  it('counts api.hyperliquid.xyz and api-ui.hyperliquid.xyz requests by type', async () => {
    await new HlClient('https://api.hyperliquid.xyz/info').read({ type: 'clearinghouseState', user: '0x1' });
    await new HlClient('https://api.hyperliquid.xyz/info').read({ type: 'metaAndAssetCtxs' });
    await new HlClient('https://api-ui.hyperliquid.xyz/info').read({ type: 'spotDeployState', user: '0x0' });
    expect(spent()).toMatchObject({ weight: 2 + 20 + 20, calls: 3 });
  });

  it('counts a request the upstream answered with an error', async () => {
    fetchMock.mockImplementation(async () => reply({}, 429));
    await expect(new HlClient('https://api.hyperliquid.xyz/info').read({ type: 'globalStats' })).rejects.toMatchObject({ statusCode: 429 });
    expect(spent()).toMatchObject({ weight: 20, calls: 1 });
  });

  it('adds the per-item extra of a long answer', async () => {
    fetchMock.mockImplementation(async () => reply(new Array(60).fill({})));
    await new HlClient('https://api.hyperliquid.xyz/info').read({ type: 'userFillsByTime', user: '0x1', startTime: 0 });
    expect(spent()).toMatchObject({ weight: 20 + 3, calls: 1 });
  });

  it('does not count HypeDexer, even for the same request types', async () => {
    fetchMock.mockImplementation(async () => reply({ balances: [] }));
    await HypeDexerInfoClient.getInstance().spotClearinghouseState('0x1');
    await new HlClient('https://api.hypedexer.com').read({ type: 'clearinghouseState', user: '0x1' });
    expect(spent()).toMatchObject({ weight: 0, calls: 0 });
  });

  it('does not change what the caller gets', async () => {
    fetchMock.mockImplementation(async () => reply({ a: 1 }));
    await expect(new HlClient('https://api.hyperliquid.xyz/info').read({ type: 'globalStats' })).resolves.toEqual({ a: 1 });
  });
});
