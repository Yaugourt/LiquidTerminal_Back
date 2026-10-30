/**
 * Reserve-yield ledger reads (BK-P-12 alerts every 60 s, BK-R-14 revenue every
 * 10 min): through HypeDexer's /info, Hyperliquid when it fails, and the rows
 * come out oldest first by (time, hash) from either, so the cursor logic sees
 * one order (HypeDexer answers newest first).
 */
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/prisma.telegram.service', () => ({ prismaTelegram: {} }));
const broadcastAlert = jest.fn();
jest.mock('../../../src/websocket/ws.server', () => ({ InternalWebSocketServer: { getInstance: () => ({ broadcastAlert }) } }));
jest.mock('../../../src/services/liquidations/liquidations.ws.service', () => ({ LiquidationsWebSocketService: {} }));
jest.mock('../../../src/clients/hyperliquid/perp/perp.assetcontext.client', () => ({ HyperliquidPerpClient: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const redisStore = new Map<string, string>();
/** Dedup claims by key, with the TTL each was claimed for. */
const claimed = new Map<string, number>();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    claimKeys: jest.fn(async (keys: string[], ttl: number) =>
      keys.map((key) => {
        if (claimed.has(key)) return false;
        claimed.set(key, ttl);
        return true;
      })
    ),
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
    }),
  },
}));

import { hyperliquidWeightMeter } from '../../../src/utils/hyperliquid-weight-meter';
import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';
import { HypeDexerInfoClient, INFO_LEDGER_MAX_ROWS, resetInfoPacing, resetInfoProxyOutages } from '../../../src/clients/hypedexer/rest/info/info.client';
import { readReserveLedger } from '../../../src/services/revenue/reserve-yield.source';
import { RevenueService } from '../../../src/services/revenue/revenue.service';
import { logDeduplicator } from '../../../src/utils/logDeduplicator';
import { compileMarketRules, MarketAlertsService } from '../../../src/services/alerts/market-alerts.service';
import { LedgerUpdate, RY_ACTIVATION_MS, RY_INTEREST_ADDRESS } from '../../../src/services/revenue/reserve-yield.ledger';

const PAYER = '0x8536a52900b5e7b23b08d6dcc50fd5689b5e270c';
const FUND = '0xfefefefefefefefefefefefefefefefefefefefe';
const send = (time: number, hash: string, user: string, destination: string, amount: string): LedgerUpdate => ({
  time,
  hash,
  delta: { type: 'send', user, destination, token: 'USDC', amount },
});

/** Oldest first, as Hyperliquid answers; two rows share a time (ties go by hash). */
const OLDEST_FIRST: LedgerUpdate[] = [
  send(1_790_960_738_677, '0x7009', PAYER, RY_INTEREST_ADDRESS, '1.0'),
  send(1_790_995_390_017, '0x4f7f', PAYER, RY_INTEREST_ADDRESS, '14580777.21'),
  send(1_790_995_390_017, '0x5a00', RY_INTEREST_ADDRESS, FUND, '14580777.21'),
  send(1_791_072_000_106, '0x9000', RY_INTEREST_ADDRESS, FUND, '15000000'),
];
const NEWEST_FIRST: LedgerUpdate[] = [...OLDEST_FIRST].reverse();

const onHyperliquid = (url: unknown): boolean => String(url).includes('hyperliquid.xyz');
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('reserve yield ledger source', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  /** HypeDexer's /info up (newest first) or down; Hyperliquid answers oldest first. */
  let proxyUp: boolean;

  beforeEach(() => {
    proxyUp = true;
    redisStore.clear();
    fetchMock = jest.fn(async (url: string) => {
      if (onHyperliquid(url)) return json(200, OLDEST_FIRST);
      return proxyUp ? json(200, NEWEST_FIRST) : json(502, null);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    (CircuitBreakerService as unknown as { instances: Map<string, unknown> }).instances.delete('hypedexer-info');
    (HypeDexerInfoClient.getInstance() as unknown as { circuitBreaker: CircuitBreakerService }).circuitBreaker =
      CircuitBreakerService.getInstance('hypedexer-info');
    resetInfoProxyOutages();
    resetInfoPacing(0);
    claimed.clear();
    broadcastAlert.mockClear();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('reads through HypeDexer and returns the rows oldest first', async () => {
    const rows = await readReserveLedger(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onHyperliquid(fetchMock.mock.calls[0][0])).toBe(false);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      type: 'userNonFundingLedgerUpdates',
      user: RY_INTEREST_ADDRESS,
      startTime: 5,
    });
    expect(rows).toEqual(OLDEST_FIRST);
  });

  it('falls back to Hyperliquid when the proxy fails, with the same rows in the same order', async () => {
    proxyUp = false;
    const rows = await readReserveLedger(5);
    expect(fetchMock.mock.calls.filter((c) => onHyperliquid(c[0]))).toHaveLength(1);
    expect(rows).toEqual(OLDEST_FIRST);
  });

  it('spends Hyperliquid weight only on the fallback', async () => {
    hyperliquidWeightMeter.reset();
    await readReserveLedger(5);
    hyperliquidWeightMeter.flush();
    expect(hyperliquidWeightMeter.lastMinute()).toMatchObject({ weight: 0, calls: 0 });

    proxyUp = false;
    await readReserveLedger(5);
    hyperliquidWeightMeter.flush();
    expect(hyperliquidWeightMeter.lastMinute()).toMatchObject({ weight: 20, calls: 1 });
    hyperliquidWeightMeter.reset();
  });

  describe('proxy answers cut at 500 rows', () => {
    /** HypeDexer keeps the newest rows: a long history comes back as 500 of them, newest first. */
    const longHistory = (count: number): LedgerUpdate[] =>
      Array.from({ length: count }, (_, i) => send(1_790_000_000_000 + i * 1000, `0x${i.toString(16).padStart(4, '0')}`, PAYER, RY_INTEREST_ADDRESS, '1.0'));

    it('reads Hyperliquid instead when the proxy returns 500 rows', async () => {
      const newest500 = longHistory(INFO_LEDGER_MAX_ROWS).reverse();
      const oldestFirst = longHistory(900).slice(0, 700); // what Hyperliquid answers from startTime
      fetchMock.mockImplementation(async (url: string) => json(200, onHyperliquid(url) ? oldestFirst : newest500));
      const rows = await readReserveLedger(5);
      expect(fetchMock.mock.calls.filter((c) => !onHyperliquid(c[0]))).toHaveLength(1);
      expect(fetchMock.mock.calls.filter((c) => onHyperliquid(c[0]))).toHaveLength(1);
      expect(rows).toEqual(oldestFirst);
      expect(rows[0].hash).toBe('0x0000');
      expect(logDeduplicator.warn).toHaveBeenCalledWith(expect.stringContaining('truncated'), expect.anything());
    });

    it('keeps the proxy answer at 499 rows', async () => {
      const rows499 = longHistory(INFO_LEDGER_MAX_ROWS - 1).reverse();
      fetchMock.mockImplementation(async (url: string) => json(200, onHyperliquid(url) ? [] : rows499));
      const rows = await readReserveLedger(5);
      expect(fetchMock.mock.calls.filter((c) => onHyperliquid(c[0]))).toHaveLength(0);
      expect(rows).toHaveLength(INFO_LEDGER_MAX_ROWS - 1);
      expect(rows[0].time).toBeLessThan(rows[rows.length - 1].time);
    });

    it('does the same for the revenue reader', async () => {
      const oldestFirst = longHistory(600);
      fetchMock.mockImplementation(async (url: string) =>
        json(200, onHyperliquid(url) ? oldestFirst : longHistory(INFO_LEDGER_MAX_ROWS).reverse())
      );
      const rows = await (RevenueService.getInstance() as unknown as { fetchReserveLedgerCached(): Promise<LedgerUpdate[]> }).fetchReserveLedgerCached();
      expect(rows).toEqual(oldestFirst);
      expect(fetchMock.mock.calls.filter((c) => onHyperliquid(c[0]))).toHaveLength(1);
    });

    it('alerts on a payment even when the proxy answer was cut', async () => {
      const cursor = 1_790_000_000_000 + 100_000;
      redisStore.set('alerts:market:reserve_yield_cursor', String(cursor));
      const oldestFirst = [...longHistory(10), send(cursor + 5_000, '0xfeed', PAYER, RY_INTEREST_ADDRESS, '5000')];
      fetchMock.mockImplementation(async (url: string) =>
        json(200, onHyperliquid(url) ? oldestFirst : longHistory(INFO_LEDGER_MAX_ROWS).reverse())
      );
      const service = MarketAlertsService.getInstance();
      const ingest = jest.spyOn((service as unknown as { engine: { ingest(e: unknown[]): void } }).engine, 'ingest').mockImplementation(() => undefined);
      await (service as unknown as { pollReserveYield(): Promise<void> }).pollReserveYield();
      const events = ingest.mock.calls.flatMap((c) => c[0] as Array<{ hash: string }>);
      ingest.mockRestore();
      expect(events.map((e) => e.hash)).toContain('0xfeed');
      expect(redisStore.get('alerts:market:reserve_yield_cursor')).toBe(String(cursor + 5_000));
    });
  });

  it('fails when both sources fail', async () => {
    proxyUp = false;
    fetchMock.mockImplementation(async () => json(500, null));
    await expect(readReserveLedger(5)).rejects.toThrow();
  });

  describe('alerts poll (60 s)', () => {
    const poll = async (): Promise<MarketEventLike[]> => {
      const service = MarketAlertsService.getInstance();
      const ingest = jest.spyOn((service as unknown as { engine: { ingest(e: unknown[]): void } }).engine, 'ingest').mockImplementation(() => undefined);
      await (service as unknown as { pollReserveYield(): Promise<void> }).pollReserveYield();
      const events = ingest.mock.calls.flatMap((c) => c[0] as MarketEventLike[]);
      ingest.mockRestore();
      return events;
    };
    interface MarketEventLike {
      id: string;
      stage: string;
      ts: number;
    }

    it('sees the same events and moves the cursor to the same time from either source', async () => {
      redisStore.set('alerts:market:reserve_yield_cursor', '1790960738677');
      const viaProxy = await poll();
      const cursorViaProxy = redisStore.get('alerts:market:reserve_yield_cursor');

      redisStore.set('alerts:market:reserve_yield_cursor', '1790960738677');
      proxyUp = false;
      const viaHyperliquid = await poll();

      expect(viaProxy.map((e) => e.id)).toEqual(viaHyperliquid.map((e) => e.id));
      expect(viaProxy.map((e) => e.stage)).toEqual(['paid', 'to_fund', 'to_fund']);
      expect(cursorViaProxy).toBe('1791072000106');
      expect(redisStore.get('alerts:market:reserve_yield_cursor')).toBe(cursorViaProxy);
    });

    describe('60 s overlap', () => {
      const CURSOR = 1_791_072_000_106;
      const startTimes = (): number[] =>
        fetchMock.mock.calls.filter((c) => !onHyperliquid(c[0])).map((c) => JSON.parse((c[1] as RequestInit).body as string).startTime as number);

      it('reads from 60 s before the cursor', async () => {
        redisStore.set('alerts:market:reserve_yield_cursor', String(CURSOR));
        await poll();
        expect(startTimes()).toEqual([CURSOR - 60_000]);
      });

      it('alerts on a row committed late, up to 60 s older than the cursor, and not on older ones', async () => {
        redisStore.set('alerts:market:reserve_yield_cursor', String(CURSOR));
        const late = send(CURSOR - 30_000, '0x1a7e', PAYER, RY_INTEREST_ADDRESS, '2000');
        const tooOld = send(CURSOR - 61_000, '0x01d0', PAYER, RY_INTEREST_ADDRESS, '3000');
        const seen = send(CURSOR, '0x5ee0', RY_INTEREST_ADDRESS, FUND, '15000000');
        fetchMock.mockImplementation(async () => json(200, [seen, late, tooOld]));
        const events = await poll();
        expect(events.map((e) => e.id)).toEqual([`ry:paid:0x1a7e:${CURSOR - 30_000}`, `ry:to_fund:0x5ee0:${CURSOR}`]);
        // The cursor never moves back.
        expect(redisStore.get('alerts:market:reserve_yield_cursor')).toBe(String(CURSOR));
      });

      it('does not alert twice on the rows the overlap reads again (24 h per-event dedup)', async () => {
        redisStore.set('alerts:market:reserve_yield_cursor', String(CURSOR - 40_000));
        const rows = [
          send(CURSOR - 30_000, '0x1a7e', PAYER, RY_INTEREST_ADDRESS, '2000'),
          send(CURSOR, '0x5ee0', RY_INTEREST_ADDRESS, FUND, '15000000'),
        ];
        fetchMock.mockImplementation(async () => json(200, rows));
        const service = MarketAlertsService.getInstance();
        const internals = service as unknown as { engine: { process(e: unknown[]): Promise<void> }; loadRules(): Promise<unknown> };
        jest.spyOn(internals, 'loadRules').mockResolvedValue(
          compileMarketRules(
            [{ id: 'r1', telegramId: '1', type: 'reserve_yield', name: 'ry', params: {} }] as unknown as Parameters<typeof compileMarketRules>[0],
            new Map()
          )
        );
        const ingest = jest.spyOn(internals.engine as unknown as { ingest(e: unknown[]): void }, 'ingest').mockImplementation(() => undefined);

        // Three polls, each reading the same rows again from the overlap window.
        for (let i = 0; i < 3; i += 1) {
          ingest.mockClear();
          await (service as unknown as { pollReserveYield(): Promise<void> }).pollReserveYield();
          await internals.engine.process(ingest.mock.calls.flatMap((c) => c[0] as unknown[]));
        }
        ingest.mockRestore();
        expect(broadcastAlert).toHaveBeenCalledTimes(2);
        // Claimed for 24 h, far more than the 60 s the overlap re-reads a row for.
        expect([...claimed.values()].every((ttl) => ttl >= 24 * 3600)).toBe(true);
      });
    });

    it('first run only stores the cursor and reads nothing', async () => {
      await poll();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redisStore.has('alerts:market:reserve_yield_cursor')).toBe(true);
    });
  });

  describe('revenue ledger (10 min cache)', () => {
    const read = (): Promise<LedgerUpdate[]> =>
      (RevenueService.getInstance() as unknown as { fetchReserveLedgerCached(): Promise<LedgerUpdate[]> }).fetchReserveLedgerCached();

    it('reads from the activation date through the proxy and caches the rows oldest first', async () => {
      const rows = await read();
      expect(rows).toEqual(OLDEST_FIRST);
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).startTime).toBe(RY_ACTIVATION_MS);
      expect(onHyperliquid(fetchMock.mock.calls[0][0])).toBe(false);
      expect(JSON.parse(redisStore.get('revenue:reserve:ledger') ?? '[]')).toEqual(OLDEST_FIRST);

      // Cached: no second read.
      await read();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads Hyperliquid when the proxy fails and caches the same rows', async () => {
      proxyUp = false;
      const rows = await read();
      expect(rows).toEqual(OLDEST_FIRST);
      expect(JSON.parse(redisStore.get('revenue:reserve:ledger') ?? '[]')).toEqual(OLDEST_FIRST);
    });
  });
});
