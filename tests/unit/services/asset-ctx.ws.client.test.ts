/**
 * Hyperliquid's activeAssetCtx stream (spot pairs + live perps on one socket):
 * - subscribes are paced at 20 a second and everything is subscribed again after
 *   a reconnect;
 * - a coin added later is subscribed, a coin that left is unsubscribed and
 *   forgotten;
 * - spot pairs answer on `activeSpotAssetCtx`, perps on `activeAssetCtx`; the
 *   latest context per coin is kept and the market flagged as changed;
 * - healthy = socket up, a frame within 15 s, >= 80 % of the subscribed coins
 *   updated within 30 s.
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
  ping(): void {}
  terminate(): void {
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
  frame(channel: string, coin: string, ctx: Record<string, unknown> = { markPx: '1.0' }): void {
    this.emit('message', Buffer.from(JSON.stringify({ channel, data: { coin, ctx } })));
  }
}

jest.mock('ws', () => ({ __esModule: true, default: FakeWS }));

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
});
