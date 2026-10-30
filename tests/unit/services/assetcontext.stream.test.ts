/**
 * The spot and perp pollers fed by the activeAssetCtx stream:
 * - the socket-merged path writes to Redis exactly what a REST read of the same
 *   contexts writes (same keys, shapes, order);
 * - every 2 s a market that changed is merged into the last REST read and
 *   written; a market that did not change is not written;
 * - REST is a read every 60 s while the stream is healthy, every 20 s while it
 *   is not, the first one at boot; each transition is logged once;
 * - a REST read subscribes new listings and drops delisted coins;
 * - a REST read never blocks a flush, and at most one is in flight per market;
 * - the spot poller can stop and releases its coins, like the perp one;
 * - a REST read failing for over 5 minutes is warned about once;
 * - HL_CTX_STREAM_ENABLED=false is today's poller: REST every 10 s, no socket.
 */
const mockRedis = {
  set: jest.fn<Promise<unknown>, [string, string]>(),
  get: jest.fn<Promise<string | null>, [string]>(),
  publish: jest.fn<Promise<unknown>, [string, string]>(),
};

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

interface MockStream {
  setCoins: jest.Mock;
  isHealthy: jest.Mock;
  consumeDirty: jest.Mock;
  getLive: jest.Mock;
  getStats: jest.Mock;
}
const mockStream: MockStream = {
  setCoins: jest.fn(),
  isHealthy: jest.fn(),
  consumeDirty: jest.fn(),
  getLive: jest.fn(),
  getStats: jest.fn(() => ({ connected: true })),
};
const mockGetInstance = jest.fn(() => mockStream);

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));
jest.mock('../../../src/clients/hyperliquid/websocket/asset-ctx.ws.client', () => ({
  HyperliquidAssetCtxWSClient: { getInstance: mockGetInstance },
}));
jest.mock('../../../src/services/spot/bridgeReserve.service', () => ({
  SpotBridgeReserveService: {
    getInstance: () => ({ load: jest.fn(async () => undefined), reserveOf: () => 0 }),
  },
}));

type Ctx = Record<string, unknown>;
type Live = Map<string, { ctx: Ctx; at: number }>;

const token = (name: string, index: number, tokenId: string): Ctx => ({
  name, szDecimals: 2, weiDecimals: 8, index, tokenId, isCanonical: false, evmContract: null, fullName: null,
});
const SPOT_META = {
  tokens: [token('USDC', 0, '0x01'), token('PURR', 1, '0x02'), token('HYPE', 150, '0x03'), token('LONE', 7, '0x04')],
  universe: [
    { name: 'PURR/USDC', tokens: [1, 0], index: 0, isCanonical: true },
    { name: '@107', tokens: [150, 0], index: 107, isCanonical: false },
  ],
};
const spotCtx = (coin: string, markPx: string, dayNtlVlm: string): Ctx => ({
  prevDayPx: '1.0', dayNtlVlm, markPx, midPx: markPx, circulatingSupply: '100.0', coin, totalSupply: '200.0', dayBaseVlm: '5.0',
});
const SPOT_OLD = [spotCtx('PURR/USDC', '0.12', '10.0'), spotCtx('@107', '85.0', '20.0'), spotCtx('#90', '0.5', '1.0')];
const SPOT_PUSHED: Ctx = spotCtx('@107', '86.5', '25.0');
const SPOT_NEW = [SPOT_OLD[0], SPOT_PUSHED, SPOT_OLD[2]];

const PERP_META = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'DEAD', szDecimals: 1, maxLeverage: 3, isDelisted: true },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
  ],
};
const perpCtx = (markPx: string, dayNtlVlm: string, funding: string): Ctx => ({
  funding, openInterest: '10.0', prevDayPx: '1.0', dayNtlVlm, premium: '0.0', oraclePx: markPx, markPx, midPx: markPx,
  impactPxs: [markPx, markPx], dayBaseVlm: '3.0',
});
const PERP_OLD = [perpCtx('80000.0', '100.0', '0.0001'), perpCtx('1.0', '0.0', '0.0'), perpCtx('4000.0', '50.0', '0.0002')];
const PERP_PUSHED: Ctx = perpCtx('81000.0', '120.0', '0.0003');
const PERP_NEW = [PERP_PUSHED, PERP_OLD[1], PERP_OLD[2]];

const liveOf = (entries: Record<string, Ctx>, at: number): Live =>
  new Map(Object.entries(entries).map(([coin, ctx]) => [coin, { ctx, at }]));

const written = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of mockRedis.set.mock.calls) out[key] = value;
  return out;
};
/** The writes without the clock-dependent one. */
const comparable = (w: Record<string, string>): Record<string, string> => {
  const { 'spot:raw_data:updated_at': _at, ...rest } = w;
  return rest;
};

interface SpotLike { startPolling(): void; stopPolling(): void; post: unknown }
const load = <T>(path: string, name: string): T => {
  jest.resetModules();
  return require(path)[name].getInstance() as T;
};
const spotClient = (): SpotLike => load<SpotLike>('../../../src/clients/hyperliquid/spot/spot.assetcontext.client', 'HyperliquidSpotClient');
const perpClient = (): SpotLike & { stopPolling(): void } =>
  load('../../../src/clients/hyperliquid/perp/perp.assetcontext.client', 'HyperliquidPerpClient');

describe('pollers fed by the activeAssetCtx stream', () => {
  let healthy: boolean;
  let dirty: boolean;
  let live: Live;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: ticks every 2000 ms exactly
    mockRedis.set.mockReset().mockResolvedValue('OK');
    mockRedis.publish.mockReset().mockResolvedValue(1);
    Object.values(mockLog).forEach((m) => m.mockClear());
    mockGetInstance.mockClear();
    Object.values(mockStream).forEach((m) => m.mockReset());
    healthy = true;
    dirty = false;
    live = new Map();
    mockStream.isHealthy.mockImplementation(() => healthy);
    mockStream.consumeDirty.mockImplementation(() => {
      const was = dirty;
      dirty = false;
      return was;
    });
    mockStream.getLive.mockImplementation(() => live);
    mockStream.getStats.mockReturnValue({ connected: true });
    delete process.env.HL_CTX_STREAM_ENABLED;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    delete process.env.HL_CTX_STREAM_ENABLED;
  });

  describe('spot', () => {
    it('writes the same Redis payloads from socket-merged contexts as from a REST read of them', async () => {
      // REST path: the contexts as one read returns them.
      process.env.HL_CTX_STREAM_ENABLED = 'false';
      const restClient = spotClient();
      jest.spyOn(restClient, 'post').mockResolvedValue([SPOT_META, SPOT_NEW]);
      restClient.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      const viaRest = comparable(written());
      expect(Object.keys(viaRest).sort()).toEqual(['spot:markets', 'spot:raw_data', 'spot:tokens:without_pairs']);

      // Socket path: an older REST read, then the pushed context.
      mockRedis.set.mockClear();
      delete process.env.HL_CTX_STREAM_ENABLED;
      const client = spotClient();
      jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(JSON.parse(written()['spot:markets'])[0].price).toBe(85);

      live = liveOf({ '@107': SPOT_PUSHED }, Date.now() + 1);
      dirty = true;
      mockRedis.set.mockClear();
      await jest.advanceTimersByTimeAsync(2000);
      const viaSocket = comparable(written());

      expect(viaSocket).toEqual(viaRest);
      expect(JSON.parse(viaSocket['spot:raw_data'])[1][2].coin).toBe('#90'); // the HIP-4 entry is kept
      expect(mockRedis.publish).toHaveBeenLastCalledWith('spot:data:updated', expect.stringContaining('DATA_UPDATED'));
      expect(mockRedis.set.mock.calls.map(([k]) => k).sort()).toEqual([
        'spot:markets', 'spot:raw_data', 'spot:raw_data:updated_at', 'spot:tokens:without_pairs',
      ]);
    });

    it('writes nothing on a tick where the market did not change, and nothing before the first REST read', async () => {
      const client = spotClient();
      jest.spyOn(client, 'post').mockRejectedValue(new Error('429'));
      dirty = true;
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      dirty = true;
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockRedis.set).not.toHaveBeenCalled();

      (client.post as jest.Mock).mockResolvedValue([SPOT_META, SPOT_OLD]);
      await jest.advanceTimersByTimeAsync(20_000);
      mockRedis.set.mockClear();
      await jest.advanceTimersByTimeAsync(4000); // not dirty
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('subscribes the pairs of the universe after each REST read, a new listing included', async () => {
      const client = spotClient();
      const post = jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockStream.setCoins).toHaveBeenLastCalledWith('spot', ['PURR/USDC', '@107']);

      post.mockResolvedValue([
        { ...SPOT_META, universe: [...SPOT_META.universe, { name: '@300', tokens: [150, 0], index: 300, isCanonical: false }] },
        [...SPOT_OLD, spotCtx('@300', '1.0', '1.0')],
      ]);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(mockStream.setCoins).toHaveBeenLastCalledWith('spot', ['PURR/USDC', '@107', '@300']);
    });

    it('reads REST at boot, then every 60 s while the stream is healthy', async () => {
      const client = spotClient();
      const post = jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(58_000);
      expect(post).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(post).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(post).toHaveBeenCalledTimes(3);
    });

    it('reads REST every 20 s while the stream is not healthy, and goes back to 60 s once it is', async () => {
      healthy = false;
      const client = spotClient();
      const post = jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(58_000);
      expect(post).toHaveBeenCalledTimes(3); // 0, 20, 40 s
      await jest.advanceTimersByTimeAsync(2_000);
      expect(post).toHaveBeenCalledTimes(4); // 60 s

      healthy = true; // t = 60 s
      await jest.advanceTimersByTimeAsync(58_000); // t = 118 s
      expect(post).toHaveBeenCalledTimes(4);
      await jest.advanceTimersByTimeAsync(2_000); // t = 120 s
      expect(post).toHaveBeenCalledTimes(5);

      healthy = false; // t = 120 s, last read 0 s ago
      await jest.advanceTimersByTimeAsync(20_000);
      expect(post).toHaveBeenCalledTimes(6);
    });

    it('does not hammer a refused read: the next one waits for the cadence', async () => {
      healthy = false;
      const client = spotClient();
      const post = jest.spyOn(client, 'post').mockRejectedValue(new Error('429'));
      client.startPolling();
      await jest.advanceTimersByTimeAsync(18_000);
      expect(post).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('logs each health transition once', async () => {
      const client = spotClient();
      jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      const transitions = (): string[] =>
        [...mockLog.info.mock.calls, ...mockLog.warn.mock.calls]
          .map(([message]) => String(message))
          .filter((m) => m.startsWith('Spot: asset-context stream'));

      healthy = false;
      client.startPolling();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(transitions()).toEqual(['Spot: asset-context stream not up yet, REST every 20 s']);

      healthy = true;
      await jest.advanceTimersByTimeAsync(10_000);
      healthy = false;
      await jest.advanceTimersByTimeAsync(10_000);
      healthy = false;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(transitions()).toEqual([
        'Spot: asset-context stream not up yet, REST every 20 s',
        'Spot: asset-context stream healthy, REST reconciles every 60 s',
        'Spot: asset-context stream not healthy, REST every 20 s',
      ]);
      expect(mockLog.warn.mock.calls.map(([m]) => String(m))).toContain('Spot: asset-context stream not healthy, REST every 20 s');
    });

    it('with the stream switched off reads REST every 10 s and never touches the socket', async () => {
      process.env.HL_CTX_STREAM_ENABLED = 'false';
      const client = spotClient();
      const post = jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(post).toHaveBeenCalledTimes(4);
      expect(mockGetInstance).not.toHaveBeenCalled();
      expect(mockStream.setCoins).not.toHaveBeenCalled();
      expect(mockStream.isHealthy).not.toHaveBeenCalled();
    });
  });

  describe('perp', () => {
    it('writes the same Redis payloads from socket-merged contexts as from a REST read of them', async () => {
      process.env.HL_CTX_STREAM_ENABLED = 'false';
      const restClient = perpClient();
      jest.spyOn(restClient, 'post').mockResolvedValue([PERP_META, PERP_NEW]);
      restClient.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      restClient.stopPolling();
      const viaRest = written();
      expect(Object.keys(viaRest).sort()).toEqual(['perp:markets', 'perp:raw_data']);

      mockRedis.set.mockClear();
      delete process.env.HL_CTX_STREAM_ENABLED;
      const client = perpClient();
      jest.spyOn(client, 'post').mockResolvedValue([PERP_META, PERP_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(JSON.parse(written()['perp:markets'])[0].price).toBe(80000);

      live = liveOf({ BTC: PERP_PUSHED }, Date.now() + 1); // a delisted perp is not subscribed
      dirty = true;
      mockRedis.set.mockClear();
      await jest.advanceTimersByTimeAsync(2000);
      const viaSocket = written();

      expect(viaSocket).toEqual(viaRest);
      expect(JSON.parse(viaSocket['perp:raw_data'])[1][1]).toEqual(PERP_OLD[1]); // delisted: as read
      expect(mockRedis.publish).toHaveBeenLastCalledWith('perp:data:updated', expect.stringContaining('DATA_UPDATED'));
      client.stopPolling();
    });

    it('subscribes the live perps only, and lets go of them when polling stops', async () => {
      const client = perpClient();
      jest.spyOn(client, 'post').mockResolvedValue([PERP_META, PERP_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockStream.setCoins).toHaveBeenLastCalledWith('perp', ['BTC', 'ETH']);
      client.stopPolling();
      expect(mockStream.setCoins).toHaveBeenLastCalledWith('perp', []);
    });

    it('reads REST at boot, every 60 s while healthy and every 20 s while not', async () => {
      const client = perpClient();
      const post = jest.spyOn(client, 'post').mockResolvedValue([PERP_META, PERP_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(58_000);
      expect(post).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(post).toHaveBeenCalledTimes(2);

      healthy = false;
      await jest.advanceTimersByTimeAsync(20_000);
      expect(post).toHaveBeenCalledTimes(3);
      client.stopPolling();
    });

    it('with the stream switched off reads REST every 10 s and never touches the socket', async () => {
      process.env.HL_CTX_STREAM_ENABLED = 'false';
      const client = perpClient();
      const post = jest.spyOn(client, 'post').mockResolvedValue([PERP_META, PERP_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(post).toHaveBeenCalledTimes(4);
      client.stopPolling();
      expect(mockGetInstance).not.toHaveBeenCalled();
      expect(mockStream.setCoins).not.toHaveBeenCalled();
    });
  });
  describe.each([
    ['spot', spotClient, 'spot:markets', [SPOT_META, SPOT_OLD], 'Spot'],
    ['perp', perpClient, 'perp:markets', [PERP_META, PERP_OLD], 'Perp'],
  ] as const)('%s decoupling of the REST read and the flush', (market, make, marketsKey, payload, label) => {
    const writesOf = (): number => mockRedis.set.mock.calls.filter(([k]) => k === marketsKey).length;
    const gate = (): { promise: Promise<unknown>; resolve: () => void } => {
      let resolve: () => void = () => undefined;
      const promise = new Promise<unknown>((r) => {
        resolve = () => r(payload);
      });
      return { promise, resolve };
    };

    it('keeps flushing while a slow REST read is pending, and starts no second one', async () => {
      const client = make();
      const post = jest.spyOn(client, 'post').mockResolvedValue(payload);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(1);

      const slow = gate();
      post.mockReturnValue(slow.promise);
      await jest.advanceTimersByTimeAsync(60_000); // the reconciliation read starts and hangs
      expect(post).toHaveBeenCalledTimes(2);

      const before = writesOf();
      for (let i = 0; i < 5; i++) {
        live = liveOf({ [market === 'spot' ? '@107' : 'BTC']: market === 'spot' ? SPOT_PUSHED : PERP_PUSHED }, Date.now() + 1);
        dirty = true;
        await jest.advanceTimersByTimeAsync(2000);
      }
      expect(writesOf()).toBe(before + 5); // one write per 2 s flush, REST still hanging

      await jest.advanceTimersByTimeAsync(100_000); // far past the next due read
      expect(post).toHaveBeenCalledTimes(2); // at most one in flight

      post.mockResolvedValue(payload);
      slow.resolve();
      await jest.advanceTimersByTimeAsync(2000);
      expect(post).toHaveBeenCalledTimes(3); // due since long: starts on the first tick after it finished
      client.stopPolling?.();
    });

    it('keeps polling after a REST read that rejected', async () => {
      healthy = false;
      const client = make();
      const post = jest.spyOn(client, 'post').mockRejectedValue(new Error('boom'));
      client.startPolling();
      await jest.advanceTimersByTimeAsync(41_000);
      expect(post).toHaveBeenCalledTimes(3);
      client.stopPolling();
    });

    it('warns once when the last good REST read is over 5 minutes old, and again after a recovery', async () => {
      const client = make();
      const post = jest.spyOn(client, 'post').mockRejectedValue(new Error('429'));
      const stale = (): number =>
        mockLog.warn.mock.calls.filter(([m]) => String(m).startsWith(`${label}: no successful REST read`)).length;

      client.startPolling();
      await jest.advanceTimersByTimeAsync(290_000);
      expect(stale()).toBe(0);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(stale()).toBe(1);
      await jest.advanceTimersByTimeAsync(300_000);
      expect(stale()).toBe(1);

      post.mockResolvedValue(payload);
      await jest.advanceTimersByTimeAsync(60_000);
      post.mockRejectedValue(new Error('429'));
      await jest.advanceTimersByTimeAsync(400_000);
      expect(stale()).toBe(2);
      client.stopPolling();
    });
  });

  describe('spot stopPolling', () => {
    it('stops the timers and releases the spot coins', async () => {
      const client = spotClient();
      const post = jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockStream.setCoins).toHaveBeenLastCalledWith('spot', ['PURR/USDC', '@107']);

      client.stopPolling();
      expect(mockStream.setCoins).toHaveBeenLastCalledWith('spot', []);
      post.mockClear();
      mockRedis.set.mockClear();
      dirty = true;
      await jest.advanceTimersByTimeAsync(120_000);
      expect(post).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();

      client.startPolling(); // can start again
      await jest.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(1);
      client.stopPolling();
    });

    it('does not touch the socket when the stream is switched off', async () => {
      process.env.HL_CTX_STREAM_ENABLED = 'false';
      const client = spotClient();
      jest.spyOn(client, 'post').mockResolvedValue([SPOT_META, SPOT_OLD]);
      client.startPolling();
      await jest.advanceTimersByTimeAsync(0);
      client.stopPolling();
      expect(mockStream.setCoins).not.toHaveBeenCalled();
    });
  });
});
