/**
 * Reserve-yield ledger reads (BK-P-12 alerts every 60 s, BK-R-14 revenue every
 * 10 min): through HypeDexer's /info, Hyperliquid when it fails, and the rows
 * come out oldest first by (time, hash) from either, so the cursor logic sees
 * one order (HypeDexer answers newest first).
 */
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/prisma.telegram.service', () => ({ prismaTelegram: {} }));
jest.mock('../../../src/websocket/ws.server', () => ({ InternalWebSocketServer: { getInstance: () => ({}) } }));
jest.mock('../../../src/services/liquidations/liquidations.ws.service', () => ({ LiquidationsWebSocketService: {} }));
jest.mock('../../../src/clients/hyperliquid/perp/perp.assetcontext.client', () => ({ HyperliquidPerpClient: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const redisStore = new Map<string, string>();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
    }),
  },
}));

import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';
import { HypeDexerInfoClient, resetInfoProxyOutages } from '../../../src/clients/hypedexer/rest/info/info.client';
import { readReserveLedger } from '../../../src/services/revenue/reserve-yield.source';
import { RevenueService } from '../../../src/services/revenue/revenue.service';
import { MarketAlertsService } from '../../../src/services/alerts/market-alerts.service';
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
