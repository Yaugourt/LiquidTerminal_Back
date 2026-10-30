/**
 * Hyperliquid's activeAssetCtx stream (spot pairs + live perps on one socket):
 * - subscribes are paced at 20 a second and everything is subscribed again after
 *   a reconnect;
 * - a coin added later is subscribed, a coin that left is unsubscribed and
 *   forgotten;
 * - spot pairs answer on `activeSpotAssetCtx`, perps on `activeAssetCtx`; the
 *   latest context per coin is kept and the market flagged as changed;
 * - healthy = socket up, a frame within 15 s, >= 80 % of the subscribed coins
 *   updated within 30 s;
 * - acknowledgements are tracked per coin, error frames are logged once per
 *   kind; a market unhealthy for over 60 s gets its missing subscribes sent
 *   again, then (60 s later) the socket is dropped, at most every 5 minutes;
 * - stop() also aborts a socket that is still connecting.
 */
import { EventEmitter } from 'events';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

class FakeWS extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  sent: Array<{ method: string; subscription: { type: string; coin: string } }> = [];
  constructor(public url: string) {
    super();
    FakeWS.instances.push(this);
  }
  send(message: string): void {
    this.sent.push(JSON.parse(message));
  }
  terminated = 0;
  ping(): void {
    setTimeout(() => this.emit('pong'), 0); // a live peer: the keep-alive never drops the socket
  }
  terminate(): void {
    this.terminated++;
    this.drop();
  }
  close(): void {
    this.drop();
  }
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.emit('open');
  }
  drop(): void {
    this.readyState = FakeWS.CLOSED;
    this.emit('close', 1006, Buffer.from(''));
  }
  raw(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
  ack(coin: string): void {
    this.raw({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'activeAssetCtx', coin } } });
  }
  frame(channel: string, coin: string, ctx: Record<string, unknown> = { markPx: '1.0' }): void {
    this.emit('message', Buffer.from(JSON.stringify({ channel, data: { coin, ctx } })));
  }
}

jest.mock('ws', () => ({ __esModule: true, default: FakeWS }));

import { logDeduplicator } from '../../../src/utils/logDeduplicator';
import { HyperliquidAssetCtxWSClient } from '../../../src/clients/hyperliquid/websocket/asset-ctx.ws.client';

const coins = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const current = (): FakeWS => FakeWS.instances[FakeWS.instances.length - 1];

describe('HyperliquidAssetCtxWSClient', () => {
  let client: HyperliquidAssetCtxWSClient;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWS.instances = [];
    client = HyperliquidAssetCtxWSClient.getInstance();
    client.stop();
    jest.mocked(logDeduplicator.error).mockClear();
    jest.mocked(logDeduplicator.warn).mockClear();
  });

  afterEach(() => {
    client.stop();
    jest.useRealTimers();
  });

  describe('subscriptions', () => {
    it('opens the socket on the first coins and paces the subscribes at 20 a second', () => {
      client.setCoins('spot', coins('@', 100));
      expect(FakeWS.instances).toHaveLength(1);
      expect(current().sent).toHaveLength(0);

      current().open();
      jest.advanceTimersByTime(0);
      expect(current().sent).toHaveLength(1);

      jest.advanceTimersByTime(950);
      expect(current().sent).toHaveLength(20);
      jest.advanceTimersByTime(1000);
      expect(current().sent).toHaveLength(40);

      jest.advanceTimersByTime(10_000);
      expect(current().sent).toHaveLength(100);
      expect(current().sent[0]).toEqual({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin: '@0' } });
      expect(new Set(current().sent.map((m) => m.subscription.coin)).size).toBe(100);
    });

    it('subscribes the spot pairs and the perps on the same socket', () => {
      client.setCoins('spot', ['@107', 'PURR/USDC']);
      client.setCoins('perp', ['BTC']);
      current().open();
      jest.advanceTimersByTime(1000);
      expect(FakeWS.instances).toHaveLength(1);
      expect(current().sent.map((m) => m.subscription.coin).sort()).toEqual(['@107', 'BTC', 'PURR/USDC']);
      expect(client.getStats().subscriptions).toEqual({ spot: 2, perp: 1, total: 3 });
    });

    it('subscribes everything again after a reconnect, paced', () => {
      client.setCoins('spot', coins('@', 30));
      client.setCoins('perp', coins('P', 10));
      current().open();
      jest.advanceTimersByTime(5000);
      expect(current().sent).toHaveLength(40);
      const first = current();

      first.drop();
      jest.advanceTimersByTime(3000); // reconnectInterval
      expect(FakeWS.instances).toHaveLength(2);
      const second = current();
      expect(second).not.toBe(first);
      second.open();
      jest.advanceTimersByTime(0);
      expect(second.sent).toHaveLength(1);
      jest.advanceTimersByTime(950);
      expect(second.sent).toHaveLength(20);
      jest.advanceTimersByTime(5000);
      expect(second.sent).toHaveLength(40);
      expect(new Set(second.sent.map((m) => m.subscription.coin))).toEqual(new Set([...coins('@', 30), ...coins('P', 10)]));
      expect(second.sent.every((m) => m.method === 'subscribe')).toBe(true);
    });

    it('subscribes a coin added later and unsubscribes one that left', () => {
      client.setCoins('spot', ['@1', '@2', '@3']);
      current().open();
      jest.advanceTimersByTime(1000);
      current().frame('activeSpotAssetCtx', '@3');
      expect(client.getLive('spot').has('@3')).toBe(true);
      current().sent.length = 0;

      client.setCoins('spot', ['@1', '@2', '@4']);
      jest.advanceTimersByTime(500);
      expect(current().sent).toEqual([
        { method: 'unsubscribe', subscription: { type: 'activeAssetCtx', coin: '@3' } },
        { method: 'subscribe', subscription: { type: 'activeAssetCtx', coin: '@4' } },
      ]);
      expect(client.getLive('spot').has('@3')).toBe(false);
      expect(client.getStats().subscriptions.spot).toBe(3);
    });

    it('does not touch the perps when the spot coins change', () => {
      client.setCoins('spot', ['@1']);
      client.setCoins('perp', ['BTC']);
      current().open();
      jest.advanceTimersByTime(1000);
      current().sent.length = 0;
      client.setCoins('spot', ['@1', '@2']);
      jest.advanceTimersByTime(500);
      expect(current().sent.map((m) => `${m.method}:${m.subscription.coin}`)).toEqual(['subscribe:@2']);
    });

    it('does not send a subscribe twice for a coin dropped and wanted again before the queue moved', () => {
      client.setCoins('spot', ['@1', '@2']);
      current().open();
      jest.advanceTimersByTime(1000);
      current().sent.length = 0;
      client.setCoins('spot', ['@1']);
      client.setCoins('spot', ['@1', '@2']);
      jest.advanceTimersByTime(500);
      expect(current().sent).toEqual([]);
    });

    it('closes the socket when no market wants a coin', () => {
      client.setCoins('spot', ['@1']);
      current().open();
      client.setCoins('spot', []);
      expect(client.isConnected()).toBe(false);
      expect(client.getStats().subscriptions.total).toBe(0);
    });
  });

  describe('frames', () => {
    beforeEach(() => {
      client.setCoins('spot', ['@107', 'PURR/USDC']);
      client.setCoins('perp', ['BTC']);
      current().open();
      jest.advanceTimersByTime(1000);
    });

    it('keeps the latest context per coin, by market, and flags the market once', () => {
      expect(client.consumeDirty('spot')).toBe(false);
      current().frame('activeSpotAssetCtx', '@107', { markPx: '90.2', circulatingSupply: '5' });
      current().frame('activeSpotAssetCtx', '@107', { markPx: '90.3', circulatingSupply: '5' });
      current().frame('activeAssetCtx', 'BTC', { markPx: '76000.0' });

      expect(client.getLive('spot').get('@107')?.ctx).toEqual({ markPx: '90.3', circulatingSupply: '5' });
      expect(client.getLive('perp').get('BTC')?.ctx).toEqual({ markPx: '76000.0' });
      expect(client.getLive('spot').has('BTC')).toBe(false);
      expect(client.consumeDirty('spot')).toBe(true);
      expect(client.consumeDirty('spot')).toBe(false);
      expect(client.consumeDirty('perp')).toBe(true);
    });

    it('ignores frames of coins nobody wants, other channels and malformed frames', () => {
      current().frame('activeSpotAssetCtx', '@999');
      current().frame('activeAssetCtx', '@107'); // a spot coin on the perp channel
      current().emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: { method: 'subscribe' } })));
      current().emit('message', Buffer.from(JSON.stringify({ channel: 'activeAssetCtx', data: { coin: 'BTC' } })));
      current().emit('message', Buffer.from('not json'));
      expect(client.getLive('spot').size).toBe(0);
      expect(client.getLive('perp').size).toBe(0);
      expect(client.getStats().framesLastMinute).toBe(0);
    });

    it('counts the frames of the last minute and the age of the last one', () => {
      current().frame('activeSpotAssetCtx', '@107');
      jest.advanceTimersByTime(20_000);
      current().frame('activeSpotAssetCtx', 'PURR/USDC');
      current().frame('activeAssetCtx', 'BTC');
      jest.advanceTimersByTime(5_000);
      expect(client.getStats()).toMatchObject({ framesLastMinute: 3, lastFrameAgeMs: 5000, subscribed: 3, pending: 0 });
      jest.advanceTimersByTime(40_000); // the first frame is now 65 s old
      expect(client.getStats().framesLastMinute).toBe(2);
    });
  });

  describe('health', () => {
    const all = coins('@', 10);

    beforeEach(() => {
      client.setCoins('spot', all);
      current().open();
      jest.advanceTimersByTime(1000);
    });

    const feed = (n: number): void => {
      for (const coin of all.slice(0, n)) current().frame('activeSpotAssetCtx', coin);
    };

    it('is not healthy before any frame', () => {
      expect(client.isHealthy('spot')).toBe(false);
    });

    it('is healthy when the socket is up, frames are fresh and 80 % of the coins updated', () => {
      feed(8);
      expect(client.isHealthy('spot')).toBe(true);
      expect(client.getStats().healthy).toEqual({ spot: true, perp: false });
    });

    it('is not healthy under 80 % coverage', () => {
      feed(7);
      expect(client.isHealthy('spot')).toBe(false);
    });

    it('is not healthy when no frame came for 15 s, then recovers with the next frames', () => {
      feed(10);
      jest.advanceTimersByTime(14_000);
      expect(client.isHealthy('spot')).toBe(true);
      jest.advanceTimersByTime(2_000);
      expect(client.isHealthy('spot')).toBe(false);
      feed(10);
      expect(client.isHealthy('spot')).toBe(true);
    });

    it('drops coverage as coins stay silent for more than 30 s', () => {
      feed(10);
      jest.advanceTimersByTime(20_000);
      feed(7); // 7 of 10 fresh at 20 s, the 3 others are 20 s old: all still covered
      expect(client.isHealthy('spot')).toBe(true);
      jest.advanceTimersByTime(12_000); // the 3 silent coins are 32 s old, 7 are 12 s
      expect(client.isHealthy('spot')).toBe(false);
    });

    it('is not healthy when the socket is down', () => {
      feed(10);
      current().drop();
      expect(client.isHealthy('spot')).toBe(false);
    });

    it('does not count coins still waiting for their subscribe against the stream', () => {
      feed(10);
      client.setCoins('spot', [...all, '@new']);
      // 10 of 11 subscribed and covered: the queued listing does not flip health
      expect(client.isHealthy('spot')).toBe(true);
    });
  });
  describe('acknowledgements and error frames', () => {
    beforeEach(() => {
      client.setCoins('spot', ['@1', '@2', '@3']);
      current().open();
      jest.advanceTimersByTime(1000);
    });

    it('counts a coin as acknowledged on its subscriptionResponse, and ignores one nobody sent', () => {
      expect(client.getStats().acknowledged).toBe(0);
      current().ack('@1');
      current().ack('@1');
      current().ack('@404');
      current().raw({ channel: 'subscriptionResponse', data: { method: 'unsubscribe', subscription: { type: 'activeAssetCtx', coin: '@2' } } });
      expect(client.getStats().acknowledged).toBe(1);
    });

    it('takes a first frame as an acknowledgement', () => {
      current().frame('activeSpotAssetCtx', '@2');
      expect(client.getStats().acknowledged).toBe(1);
    });

    it('forgets the acknowledgements on a new connection', () => {
      current().ack('@1');
      current().drop();
      jest.advanceTimersByTime(3000);
      current().open();
      expect(client.getStats().acknowledged).toBe(0);
    });

    it('logs an error frame with its message, once per kind of error, and counts them all', () => {
      for (const coin of ['@1', '@2', '@3']) {
        current().raw({ channel: 'error', data: `Invalid subscription {"type":"activeAssetCtx","coin":"${coin}"}` });
      }
      expect(client.getStats().errorFrames).toBe(3);
      const errors = jest.mocked(logDeduplicator.error).mock.calls.filter(([m]) => String(m).includes('error frame'));
      expect(errors).toHaveLength(1);
      expect(errors[0][1]).toMatchObject({ message: expect.stringContaining('Invalid subscription'), coin: '@1' });

      current().raw({ channel: 'error', data: 'Too many subscriptions' });
      expect(jest.mocked(logDeduplicator.error).mock.calls.filter(([m]) => String(m).includes('error frame'))).toHaveLength(2);

      jest.advanceTimersByTime(61_000);
      current().raw({ channel: 'error', data: 'Invalid subscription {"type":"activeAssetCtx","coin":"@9"}' });
      const again = jest.mocked(logDeduplicator.error).mock.calls.filter(([m]) => String(m).includes('error frame'));
      expect(again).toHaveLength(3);
      expect(again[2][1]).toMatchObject({ suppressedSincePrevious: 2 });
    });

    it('reads "Already subscribed" as an acknowledgement and any other error as a refusal', () => {
      current().ack('@1');
      current().ack('@2');
      current().raw({ channel: 'error', data: 'Already subscribed: {"type":"activeAssetCtx","coin":"@3"}' });
      expect(client.getStats().acknowledged).toBe(3);
      current().raw({ channel: 'error', data: 'Invalid subscription {"type":"activeAssetCtx","coin":"@2"}' });
      expect(client.getStats().acknowledged).toBe(2);
    });

    it('survives an error frame with a non-string payload', () => {
      current().raw({ channel: 'error', data: { code: 1 } });
      current().raw({ channel: 'error' });
      expect(client.getStats().errorFrames).toBe(2);
    });
  });

  describe('recovery of an unhealthy market', () => {
    const all = coins('@', 10);
    const resentCoins = (ws: FakeWS, from: number): string[] => ws.sent.slice(from).map((m) => m.subscription.coin);

    beforeEach(() => {
      client.setCoins('spot', all);
      current().open();
      jest.advanceTimersByTime(1000); // all 10 sent at t = 1 s
      for (const coin of all.slice(0, 8)) current().ack(coin); // @8 and @9 were refused
    });

    it('subscribes again, after 60 s unhealthy, the coins not acknowledged or not updating only', () => {
      jest.advanceTimersByTime(59_000); // t = 60 s
      for (const coin of all.slice(0, 7)) current().frame('activeSpotAssetCtx', coin); // 70 %: unhealthy
      expect(current().sent).toHaveLength(10);

      jest.advanceTimersByTime(5_000); // t = 65 s: the clock started at 5 s, 60 s not yet over
      expect(current().sent).toHaveLength(10);

      jest.advanceTimersByTime(10_000); // t = 75 s
      expect(resentCoins(current(), 10).sort()).toEqual(['@7', '@8', '@9']);
      expect(client.getStats().recovery).toEqual({ resends: 1, forcedReconnects: 0 });
      expect(logDeduplicator.warn).toHaveBeenCalledWith(
        expect.stringContaining('subscribing again'),
        expect.objectContaining({ resent: 3, notAcknowledged: 2 })
      );
    });

    it('resends once per episode, paced like any subscribe', () => {
      jest.advanceTimersByTime(70_000);
      const afterFirst = current().sent.length;
      expect(afterFirst).toBeGreaterThan(10);
      jest.advanceTimersByTime(40_000); // t = 110 s: still waiting for the 60 s after the resend
      expect(current().sent).toHaveLength(afterFirst);
    });

    it('waits for the send queue to be empty before counting the 60 s', () => {
      client.stop();
      const many = coins('@', 1500); // 75 s of pacing
      client.setCoins('spot', many);
      current().open();
      jest.advanceTimersByTime(70_000);
      // still draining: nothing is sent twice, no recovery yet
      expect(new Set(current().sent.map((m) => m.subscription.coin)).size).toBe(current().sent.length);
      expect(client.getStats().recovery.resends).toBe(0);
    });

    it('drops the socket 60 s after the resend if the market is still unhealthy, and subscribes everything again', () => {
      jest.advanceTimersByTime(70_000); // resend
      const first = current();
      jest.advanceTimersByTime(55_000); // t = 125 s
      expect(first.terminated).toBe(0);
      jest.advanceTimersByTime(15_000); // t = 140 s
      expect(first.terminated).toBe(1);
      expect(client.getStats().recovery.forcedReconnects).toBe(1);

      jest.advanceTimersByTime(3_000);
      expect(FakeWS.instances).toHaveLength(2);
      current().open();
      jest.advanceTimersByTime(1000);
      expect(new Set(current().sent.map((m) => m.subscription.coin))).toEqual(new Set(all));
    });

    it('forces at most one reconnect every 5 minutes', () => {
      jest.advanceTimersByTime(140_000); // first forced reconnect at about 135 s
      jest.advanceTimersByTime(3_000);
      expect(FakeWS.instances).toHaveLength(2);
      current().open();

      jest.advanceTimersByTime(280_000); // t = 423 s: well past a resend + 60 s, under 135 + 300
      expect(FakeWS.instances).toHaveLength(2);
      expect(client.getStats().recovery.forcedReconnects).toBe(1);

      jest.advanceTimersByTime(25_000); // t = 448 s
      jest.advanceTimersByTime(3_000);
      expect(FakeWS.instances).toHaveLength(3);
      expect(client.getStats().recovery.forcedReconnects).toBe(2);
    });

    it('does nothing while the market is healthy', () => {
      for (let i = 0; i < 15; i++) {
        for (const coin of all) current().frame('activeSpotAssetCtx', coin);
        jest.advanceTimersByTime(10_000);
      }
      expect(current().sent).toHaveLength(10);
      expect(client.getStats().recovery).toEqual({ resends: 0, forcedReconnects: 0 });
    });

    it('stops looking once the socket is down', () => {
      current().drop();
      jest.advanceTimersByTime(2_000); // before the reconnect
      expect(client.getState()).toBe('reconnecting');
      expect(client.getStats().recovery).toEqual({ resends: 0, forcedReconnects: 0 });
    });
  });

  describe('stop', () => {
    it('terminates a socket that is still connecting and does not reconnect', () => {
      client.setCoins('spot', ['@1']);
      const connecting = current();
      expect(connecting.readyState).toBe(FakeWS.CONNECTING);

      client.stop();
      expect(connecting.terminated).toBe(1);
      expect(client.getState()).toBe('disconnected');

      connecting.open(); // too late: nobody listens
      jest.advanceTimersByTime(120_000);
      expect(client.isConnected()).toBe(false);
      expect(FakeWS.instances).toHaveLength(1);
      expect(client.getStats().subscribed).toBe(0);
    });

    it('can start again after stopping a connecting socket', () => {
      client.setCoins('spot', ['@1']);
      client.stop();
      client.setCoins('spot', ['@2']);
      expect(FakeWS.instances).toHaveLength(2);
      current().open();
      jest.advanceTimersByTime(500);
      expect(current().sent.map((m) => m.subscription.coin)).toEqual(['@2']);
    });
  });
});
