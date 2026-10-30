/**
 * HIP-4 reads are shared through Redis: market tapes by age of their newest
 * fill, metadata lists once for every enriched endpoint and settlements, and
 * every cache key carries every param sent upstream.
 */
const mockRedis = {
  store: new Map<string, string>(),
  ttls: new Map<string, number | undefined>(),
  get: jest.fn(async (key: string) => mockRedis.store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, ttl?: number) => {
    mockRedis.store.set(key, value);
    mockRedis.ttls.set(key, ttl);
  }),
  delete: jest.fn(async (key: string) => {
    mockRedis.store.delete(key);
  }),
  getClient: () => ({ set: async () => 'OK' }),
  isHealthy: () => true,
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockClient = {
  getFills: jest.fn(),
  getMarkets: jest.fn(),
  getQuestions: jest.fn(),
  getSettlements: jest.fn(),
  getOutcomeTokens: jest.fn(),
  getAnalytics: jest.fn(),
};

jest.mock('../../../src/clients/hypedexer/rest/hip4/hip4.client', () => ({
  HypeDexerHip4Client: { getInstance: () => mockClient },
}));

import { IndexerHip4Service } from '../../../src/services/indexer/indexer-hip4.service';
import { HYPEDEXER_TTL } from '../../../src/constants/hypedexer.cache';
import { OUTCOME_TEMPLATES } from '../utils/hip4-templates.fixture';
import { runWithUpstreamCaller } from '../../../src/utils/request-context';
import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';
import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';

const HOUR = 60 * 60 * 1000;
const fill = (coin: string, ageMs: number) => ({ coin, px: 0.5, sz: 2, time_ms: Date.now() - ageMs, fee_usdc: 0 });

function storedTtl(fragment: string): number | undefined {
  const key = [...mockRedis.ttls.keys()].find((k) => k.includes(fragment));
  return key ? mockRedis.ttls.get(key) : undefined;
}

describe('IndexerHip4Service caching', () => {
  let svc: IndexerHip4Service;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.ttls.clear();
    Object.values(mockClient).forEach((fn) => fn.mockReset());
    (IndexerHip4Service as unknown as { instance?: IndexerHip4Service }).instance = undefined;
    svc = IndexerHip4Service.getInstance();
    // HL allMids (free, not HypeDexer): answer with nothing.
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ json: async () => ({}) } as Response);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('shares a market tape across visitors and keeps the transformed shape', async () => {
    mockClient.getFills.mockResolvedValue([fill('#1010', 5_000)]);

    const first = (await svc.getFills({ coin: '#1010', limit: 400 })) as Array<Record<string, unknown>>;
    const second = await svc.getFills({ coin: '#1010', limit: 400 });

    expect(mockClient.getFills).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ coin: '#1010', notional: 1, fee: 0 });
    expect(typeof first[0].time).toBe('string');
  });

  it('keeps a tape by the age of its newest fill', async () => {
    mockClient.getFills.mockImplementation(async ({ coin }: { coin?: string }) => {
      if (coin === '#1') return [fill(coin, 2 * 24 * HOUR), fill(coin, 3 * 24 * HOUR)];
      if (coin === '#2') return [fill(coin, 3 * HOUR)];
      if (coin === '#3') return [];
      return [fill('#4', 30_000), fill('#4', 2 * 24 * HOUR)];
    });

    await svc.getFills({ coin: '#1', limit: 1000 });
    await svc.getFills({ coin: '#2', limit: 1000 });
    await svc.getFills({ coin: '#3', limit: 1000 });
    await svc.getFills({ limit: 50 });

    expect(storedTtl('"coin":"#1"')).toBe(HYPEDEXER_TTL.hip4DormantFills);
    expect(storedTtl('"coin":"#2"')).toBe(HYPEDEXER_TTL.hip4QuietFills);
    expect(storedTtl('"coin":"#3"')).toBe(HYPEDEXER_TTL.hip4QuietFills);
    expect(storedTtl('fills:{"limit":50}')).toBe(HYPEDEXER_TTL.hip4ActiveFills);
  });

  it('does not treat rows without a readable time as dormant', async () => {
    mockClient.getFills.mockResolvedValue([{ coin: '#9', px: 1, sz: 1 }]);
    await svc.getFills({ coin: '#9' });
    expect(storedTtl('"coin":"#9"')).toBe(HYPEDEXER_TTL.hip4QuietFills);
  });

  describe('a dormant coin tape whose market left outcomeMeta', () => {
    /** HL answers outcomeMeta with these outcome ids (or fails), allMids with nothing. */
    const listOutcomes = (outcomes: number[] | 'fail') =>
      fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
        if (String(init?.body ?? '').includes('outcomeMeta')) {
          if (outcomes === 'fail') throw new Error('HL down');
          return { ok: true, json: async () => ({ outcomes: outcomes.map((outcome) => ({ outcome })) }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      });
    const outcomeMetaReads = () =>
      fetchSpy.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.body ?? '').includes('outcomeMeta')).length;

    it('is kept a day, while a dormant market still listed keeps the hour', async () => {
      listOutcomes([5]);
      mockClient.getFills.mockImplementation(async ({ coin }: { coin?: string }) => [fill(coin ?? '#0', 2 * 24 * HOUR)]);

      await svc.getFills({ coin: '#1100', limit: 1000 }); // outcome 110: gone
      await svc.getFills({ coin: '#51', limit: 1000 }); // outcome 5: listed

      expect(storedTtl('"coin":"#1100"')).toBe(HYPEDEXER_TTL.hip4DelistedFills);
      expect(storedTtl('"coin":"#51"')).toBe(HYPEDEXER_TTL.hip4DormantFills);
      expect(HYPEDEXER_TTL.hip4DelistedFills).toBe(86400);
      // The outcome ids are shared: one outcomeMeta read for both tapes.
      expect(outcomeMetaReads()).toBe(1);
    });

    it('is only asked about for a dormant coin tape', async () => {
      listOutcomes([5]);
      mockClient.getFills.mockImplementation(async ({ coin }: { coin?: string }) =>
        coin === '#1100' ? [fill(coin, 5_000)] : [fill('#1110', 2 * 24 * HOUR)]);

      await svc.getFills({ coin: '#1100', limit: 400 }); // active
      await svc.getFills({ limit: 50 }); // the global tape, dormant

      expect(storedTtl('"coin":"#1100"')).toBe(HYPEDEXER_TTL.hip4ActiveFills);
      expect(storedTtl('fills:{"limit":50}')).toBe(HYPEDEXER_TTL.hip4DormantFills);
      expect(outcomeMetaReads()).toBe(0);
    });

    it('keeps an active coin\u2019s head read (limit 50) 5 s, and only that read', async () => {
      listOutcomes([5, 120]);
      mockClient.getFills.mockImplementation(async ({ coin }: { coin?: string }) =>
        coin === '#1200' ? [fill(coin, 2 * 24 * HOUR)] : [fill(coin ?? '#1110', 5_000)]);

      await svc.getFills({ coin: '#1100', limit: 50 }); // head of an active coin
      await svc.getFills({ coin: '#1100', limit: 400 }); // its full read
      await svc.getFills({ coin: '#1110', limit: 49 }); // not the head the front sends
      await svc.getFills({ limit: 50 }); // the global tape
      await svc.getFills({ coin: '#1200', limit: 50 }); // head of a dormant coin: back-off kept

      expect(storedTtl('"coin":"#1100","limit":50')).toBe(HYPEDEXER_TTL.hip4ActiveHeadFills);
      expect(storedTtl('"coin":"#1100","limit":400')).toBe(HYPEDEXER_TTL.hip4ActiveFills);
      expect(storedTtl('"coin":"#1110","limit":49')).toBe(HYPEDEXER_TTL.hip4ActiveFills);
      expect(storedTtl('fills:{"limit":50}')).toBe(HYPEDEXER_TTL.hip4ActiveFills);
      expect(storedTtl('"coin":"#1200","limit":50')).toBe(HYPEDEXER_TTL.hip4DormantFills);
      expect(HYPEDEXER_TTL.hip4ActiveHeadFills).toBe(5);
    });

    it('keeps the hour for reads the front does not make, without asking', async () => {
      listOutcomes([5]);
      mockClient.getFills.mockImplementation(async ({ coin }: { coin?: string }) => [fill(coin ?? '#0', 2 * 24 * HOUR)]);

      await svc.getFills({ coin: '#1100', limit: 1000, start: '2026-05-01' });
      await svc.getFills({ coin: '#1100', limit: 1000, offset: 1000 });
      await svc.getFills({ coin: '#1105', limit: 1000 }); // not a side coin

      expect(storedTtl('"start":"2026-05-01"')).toBe(HYPEDEXER_TTL.hip4DormantFills);
      expect(storedTtl('"offset":1000')).toBe(HYPEDEXER_TTL.hip4DormantFills);
      expect(storedTtl('"coin":"#1105"')).toBe(HYPEDEXER_TTL.hip4DormantFills);
      expect(outcomeMetaReads()).toBe(0);
    });

    it('keeps the hour when outcomeMeta fails or lists nothing', async () => {
      mockClient.getFills.mockImplementation(async ({ coin }: { coin?: string }) => [fill(coin ?? '#0', 2 * 24 * HOUR)]);

      listOutcomes('fail');
      await svc.getFills({ coin: '#1100', limit: 1000 });
      expect(storedTtl('"coin":"#1100"')).toBe(HYPEDEXER_TTL.hip4DormantFills);

      listOutcomes([]);
      await svc.getFills({ coin: '#1110', limit: 1000 });
      expect(storedTtl('"coin":"#1110"')).toBe(HYPEDEXER_TTL.hip4DormantFills);
    });
  });

  it('keys a wallet’s fills on every filter', async () => {
    const user = '0x1111111111111111111111111111111111111111';
    mockClient.getFills.mockImplementation(async (p: { coin?: string }) => [fill(p.coin ?? '#0', 1_000)]);

    const all = (await svc.getFills({ user })) as Array<{ coin: string }>;
    const one = (await svc.getFills({ user, coin: '#1010' })) as Array<{ coin: string }>;

    expect(mockClient.getFills).toHaveBeenCalledTimes(2);
    expect(all[0].coin).toBe('#0');
    expect(one[0].coin).toBe('#1010');
    expect(storedTtl(`hip4:user:${user}`)).toBe(HYPEDEXER_TTL.userFills);
  });

  it('reads the metadata lists once for enriched markets, questions and settlements', async () => {
    mockClient.getMarkets.mockResolvedValue([
      { outcome_id: 10, question_id: null, coin: '#10', class: 'priceBinary', underlying: 'BTC', name: 'Recurring', target_price: 1, total_volume: 5 },
    ]);
    mockClient.getOutcomeTokens.mockResolvedValue([{ outcome_id: 10, coin: '#10', spot_name: 'USDC' }]);
    mockClient.getQuestions.mockResolvedValue([{ question_id: 1, name: 'Q', description: null, fallback_outcome: null, named_outcomes: [], settled_named_outcomes: [] }]);
    mockClient.getSettlements.mockResolvedValue([{ outcome_id: 10, settle_fraction: 1, details: 'price:2', block_time: '2026-09-28T06:00:00' }]);

    await svc.getMarketsEnriched();
    await svc.getQuestionsWithOutcomes();
    const settlements = await svc.getSettlements({ limit: 50 });
    await svc.getSettlements({ limit: 50 });

    expect(mockClient.getMarkets).toHaveBeenCalledTimes(1);
    expect(mockClient.getOutcomeTokens).toHaveBeenCalledTimes(1);
    expect(mockClient.getQuestions).toHaveBeenCalledTimes(1);
    expect(mockClient.getSettlements).toHaveBeenCalledTimes(1);
    expect(settlements).toEqual([expect.objectContaining({ outcome_id: 10, winner_side: 0, settled_px: 2 })]);
    expect(storedTtl('hypedexer:hip4:markets')).toBe(HYPEDEXER_TTL.hip4BaseList);
    expect(storedTtl('hypedexer:hip4:settlements')).toBe(HYPEDEXER_TTL.hip4Settlements);
    // The odds (mid_price) are live: 15 s, not the lists' 10 min.
    expect(storedTtl('markets-enriched')).toBe(HYPEDEXER_TTL.hip4EnrichedList);
    expect(storedTtl('questions-with-outcomes')).toBe(HYPEDEXER_TTL.hip4EnrichedList);
    expect(HYPEDEXER_TTL.hip4EnrichedList).toBe(15);
  });

  it('lists a market with no question once, without the side-coin placeholder rows', async () => {
    const base = { question_id: null, class: '', underlying: '', settled: 0 };
    mockClient.getMarkets.mockResolvedValue([
      { ...base, outcome_id: 1472, coin: '#1472', name: 'NBA Finals Game 5', description: '', side_specs: '[{"name":"San Antonio"},{"name":"New York"}]' },
      // HypeDexer's row for a traded side coin: nothing of its own.
      { ...base, outcome_id: 14720, coin: '#14720', name: '#14720', description: '', side_specs: null },
      // Named after its coin but described: a market, as deep links read it.
      { ...base, outcome_id: 14730, coin: '#14730', name: '#14730', description: 'Will it rain?', side_specs: null },
    ]);
    mockClient.getOutcomeTokens.mockResolvedValue([]);
    mockClient.getQuestions.mockResolvedValue([]);

    const questions = await svc.getQuestionsWithOutcomes();

    expect(questions.map((q) => q.singleton_outcome_id).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1472, 14730]);
    expect(questions.find((q) => q.singleton_outcome_id === 1472)?.outcomes.map((o) => o.coin)).toEqual(['#14720', '#14721']);
  });

  it('answers markets-enriched per limit instead of whichever limit came first', async () => {
    mockClient.getMarkets.mockImplementation(async ({ limit }: { limit?: number }) =>
      Array.from({ length: limit ?? 100 }, (_, i) => ({ outcome_id: 10 + i, question_id: null, coin: `#${10 + i}`, class: null, underlying: null, name: null }))
    );
    mockClient.getOutcomeTokens.mockResolvedValue([]);
    mockClient.getQuestions.mockResolvedValue([]);

    const big = await svc.getMarketsEnriched({ limit: 500 });
    const small = await svc.getMarketsEnriched();

    expect(big).toHaveLength(500);
    expect(small).toHaveLength(100);
  });

  describe('one market by outcome_id (deep links)', () => {
    // Raw outcome 6024 on 2026-09-29: HL trades it as #60240 (Yes) / #60241 (No).
    const hype6024 = {
      outcome_id: 6024,
      coin: '#6024',
      name: 'Recurring',
      description: 'class:priceBinary|underlying:HYPE|expiry:20260928-0600|targetPrice:93.017|period:1d',
      class: 'priceBinary',
      underlying: 'HYPE',
      expiry: '20260928-0600',
      target_price: 93.017,
      period: '1d',
      side_specs: '[{"name":"Yes"},{"name":"No"}]',
      question_id: null,
      settled: 1,
      block_time: '2026-09-28T06:00:12.035000',
      total_volume: 22068.45,
    };
    const bare60240 = { ...hype6024, outcome_id: 60240, coin: '#60240', name: '#60240', description: '', class: '', underlying: '', expiry: '', side_specs: '[]', settled: 0 };

    it('answers a traded side coin from its outcome row, read once for both sides', async () => {
      mockClient.getMarkets.mockImplementation(async ({ outcome_id }: { outcome_id?: number }) =>
        outcome_id === 6024 ? [hype6024, hype6024, hype6024] : []
      );

      const [yes] = await svc.getMarketsEnriched({ outcome_id: 60240 });
      const [no] = await svc.getMarketsEnriched({ outcome_id: 60241 });

      expect(mockClient.getMarkets).toHaveBeenCalledTimes(1);
      expect(mockClient.getMarkets).toHaveBeenCalledWith({ outcome_id: 6024 });
      expect(yes).toMatchObject({
        outcome_id: 60240,
        coin: '#60240',
        side: 0,
        side_name: 'Yes',
        display_name: 'HYPE above 93.017 on Sep 28 at 6:00 AM UTC?',
        underlying: 'HYPE',
        target_price: 93.017,
        is_settled: true,
        settled_at: '2026-09-28T06:00:12.035000Z',
        total_volume: 22068.45,
      });
      expect(no).toMatchObject({ outcome_id: 60241, coin: '#60241', side: 1, side_name: 'No' });
      expect(storedTtl('hypedexer:hip4:market:{"outcome_id":6024}')).toBe(HYPEDEXER_TTL.hip4SettledMarket);
    });

    it('keeps an open market for minutes, not a day', async () => {
      mockClient.getMarkets.mockResolvedValue([{ ...hype6024, settled: 0 }]);
      await svc.getMarketsEnriched({ outcome_id: 60240 });
      expect(storedTtl('hypedexer:hip4:market:{"outcome_id":6024}')).toBe(HYPEDEXER_TTL.hip4OpenMarket);
    });

    it('reads an id that is not a side coin as an outcome', async () => {
      mockClient.getMarkets.mockImplementation(async ({ outcome_id }: { outcome_id?: number }) =>
        outcome_id === 6024 ? [hype6024] : []
      );
      const rows = await svc.getMarketsEnriched({ outcome_id: 6024 });
      expect(mockClient.getMarkets).toHaveBeenCalledTimes(1);
      expect(mockClient.getMarkets).toHaveBeenCalledWith({ outcome_id: 6024 });
      expect(rows).toEqual([expect.objectContaining({ outcome_id: 6024, side: null })]);
    });

    it('answers nothing for an unknown id or a lone placeholder, and asks again soon', async () => {
      mockClient.getMarkets.mockImplementation(async ({ outcome_id }: { outcome_id?: number }) =>
        outcome_id === 60240 ? [bare60240] : []
      );
      expect(await svc.getMarketsEnriched({ outcome_id: 60240 })).toEqual([]);
      expect(storedTtl('hypedexer:hip4:market:{"outcome_id":6024}')).toBe(HYPEDEXER_TTL.hip4BaseListRetry);
    });

    it('drops rows for other ids if the filter is ignored upstream', async () => {
      mockClient.getMarkets.mockResolvedValue([{ ...hype6024, outcome_id: 1 }, { ...hype6024, outcome_id: 2 }]);
      expect(await svc.getMarketsEnriched({ outcome_id: 60240 })).toEqual([]);
    });

    it('titles a templated market from the registry', async () => {
      fetchSpy.mockImplementation(async (_url: unknown, init?: { body?: string }) => ({
        ok: true,
        json: async () => (JSON.parse(init?.body ?? '{}').type === 'outcomeTemplates' ? OUTCOME_TEMPLATES : {}),
      }) as Response);
      mockClient.getMarkets.mockResolvedValue([{
        ...hype6024,
        outcome_id: 6537,
        coin: '#6537',
        name: 'template:binaryPrice',
        description: 'perp:HYPE|priceDescription:HYPE-USDC perp mark|seconds:60|threshold:86.859|time:20260928-2245',
        class: '',
        underlying: '',
        expiry: '',
        target_price: 0,
        side_specs: '[{"name":"template:Yes"},{"name":"template:No"}]',
      }]);

      const [m] = await svc.getMarketsEnriched({ outcome_id: 65371 });

      expect(m).toMatchObject({
        outcome_id: 65371,
        side_name: 'No',
        display_name: 'HYPE above 86.859 at Sep 28, 10:45 PM UTC?',
        class: 'priceBinary',
        target_price: 86.859,
      });
      expect(storedTtl('hyperliquid:hip4:outcome-templates')).toBe(HYPEDEXER_TTL.hip4OutcomeTemplates);
    });
  });

  describe('settlement names', () => {
    const settlement = (outcome_id: number) => ({ outcome_id, settle_fraction: 0, details: 'price:89.0163', block_time: '2026-09-28T06:00:14.527538' });
    const hype6024 = {
      outcome_id: 6024,
      coin: '#6024',
      name: 'Recurring',
      description: 'class:priceBinary|underlying:HYPE|expiry:20260928-0600|targetPrice:93.017|period:1d',
      class: 'priceBinary',
      underlying: 'HYPE',
      expiry: '20260928-0600',
      target_price: 93.017,
      side_specs: '[{"name":"Yes"},{"name":"No"}]',
      question_id: null,
      settled: 1,
    };

    beforeEach(() => {
      mockClient.getOutcomeTokens.mockResolvedValue([]);
      mockClient.getQuestions.mockResolvedValue([]);
    });

    it('reads each market missing from the metadata list once, and names its settlement', async () => {
      // The list holds outcome 10 only; the settlements page is about 6024 (three broadcasters).
      mockClient.getMarkets.mockImplementation(async (p: { outcome_id?: number }) =>
        p.outcome_id === 6024 ? [hype6024] : p.outcome_id == null ? [{ ...hype6024, outcome_id: 10, coin: '#10' }] : []
      );
      mockClient.getSettlements.mockResolvedValue([settlement(6024), settlement(6024), settlement(6024), settlement(10)]);

      const rows = await svc.getSettlements({ limit: 50 });

      expect(mockClient.getMarkets).toHaveBeenCalledWith({ outcome_id: 6024 });
      expect(mockClient.getMarkets).toHaveBeenCalledTimes(2); // the list + 6024
      expect(rows.find((s) => s.outcome_id === 6024)).toMatchObject({
        question_name: 'HYPE above 93.017 on Sep 28 at 6:00 AM UTC?',
        winner_name: 'No',
        coin: '#6024',
      });

      // The next assembly (settlements expired) reuses the market's row.
      mockRedis.store.delete([...mockRedis.store.keys()].find((k) => k.startsWith('hypedexer:hip4:settlements'))!);
      await svc.getSettlements({ limit: 50 });
      expect(mockClient.getMarkets).toHaveBeenCalledTimes(2);
    });

    it('leaves a settlement unnamed when its market cannot be read', async () => {
      mockClient.getMarkets.mockImplementation(async (p: { outcome_id?: number }) => {
        if (p.outcome_id != null) throw new Error('Circuit breaker is open');
        return [];
      });
      mockClient.getSettlements.mockResolvedValue([settlement(6024)]);

      const [row] = await svc.getSettlements({ limit: 50 });

      expect(row).toMatchObject({ outcome_id: 6024, question_name: null, winner_name: 'No' });
    });

    it('reads at most 50 markets for one page', async () => {
      mockClient.getMarkets.mockResolvedValue([]);
      mockClient.getSettlements.mockResolvedValue(Array.from({ length: 80 }, (_, i) => settlement(7000 + i)));

      await svc.getSettlements({ limit: 80 });

      const lookups = mockClient.getMarkets.mock.calls.filter(([p]) => p?.outcome_id != null);
      expect(lookups).toHaveLength(50);
    });
  });

  describe('how the markets that no longer trade ended', () => {
    const DAY = 24 * HOUR;
    const side = (outcome_id: number, display_name: string, coin?: string) => ({
      outcome_id,
      side_name: display_name,
      display_name,
      mid_price: null,
      volume_24h: null,
      total_volume: null,
      open_interest: null,
      is_settled: false,
      settled_at: null,
      ...(coin ? { coin } : {}),
    });
    const question = (question_id: number | null, status: 'live' | 'settled', outcomes: ReturnType<typeof side>[]) => ({
      question_id,
      title: 'Q',
      description: null,
      class: null,
      underlying: null,
      outcome_count: outcomes.length,
      total_volume: 0,
      created_at: null,
      resolved_at: null,
      status,
      singleton_outcome_id: null,
      expiry: null,
      period: null,
      target_price: null,
      outcomes,
    });
    const QUESTIONS = [
      question(null, 'settled', [side(154, 'Yes', '#1540'), side(154, 'No', '#1541')]),
      question(null, 'settled', [side(155, 'Yes', '#1550'), side(155, 'No', '#1551')]), // no settlement on record
      question(null, 'live', [side(110, 'PSG', '#1100'), side(110, 'Arsenal', '#1101')]), // delisted
      question(50, 'live', [side(300, 'Below'), side(301, 'Exactly'), side(302, 'Above'), side(303, 'Other / Disputed')]),
      question(null, 'live', [side(1480, 'Yes', '#14800'), side(1480, 'No', '#14801')]), // still listed
    ];
    const LAST_PX: Record<string, number> = {
      '#1540': 0.001, '#1541': 0.999,
      '#1550': 0.6, '#1551': 0.4,
      '#1100': 0.99991, '#1101': 0.0001,
      '#3000': 0.001, '#3010': 0.999, '#3020': 0,
    };
    const trade = (coin: string, px: number, ageMs: number) => ({ coin, px, sz: 1, dir: 'Buy', time_ms: Date.now() - ageMs, fee_usdc: 0 });
    /** A merge after the last trade: protocol actions are no trades. */
    const tape = (coin: string, ageMs = 3 * DAY) => [
      { coin, px: 0.5, sz: 1, dir: 'Merge Outcome', time_ms: Date.now() - ageMs + HOUR, fee_usdc: 0 },
      trade(coin, LAST_PX[coin], ageMs),
    ];
    const listOutcomes = (outcomes: number[] | 'fail') =>
      fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
        if (String(init?.body ?? '').includes('outcomeMeta')) {
          if (outcomes === 'fail') throw new Error('HL down');
          return { ok: true, json: async () => ({ outcomes: outcomes.map((outcome) => ({ outcome })) }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      });
    const ttlOf = (...fragments: string[]) => {
      const key = [...mockRedis.ttls.keys()].find((k) => fragments.every((f) => k.includes(f)));
      return key ? mockRedis.ttls.get(key) : undefined;
    };
    let questions: jest.SpyInstance;

    beforeEach(() => {
      questions = jest.spyOn(svc, 'getQuestionsWithOutcomes').mockResolvedValue(QUESTIONS);
      listOutcomes([1480, 5]);
      mockClient.getFills.mockImplementation(async ({ coin }: { coin: string }) => tape(coin));
      mockClient.getSettlements.mockImplementation(async ({ outcome_id }: { outcome_id: number }) =>
        outcome_id === 154 ? [{ outcome_id: 154, settle_fraction: 0, block_time: '2026-06-05T06:00:04' }] : []
      );
    });

    it('names the winner from a settlement, else from the last trades, and leaves listed markets out', async () => {
      const { coins } = await svc.getResolutions();

      expect(coins['#1541']).toMatchObject({ won: true, won_by: 'settlement', final_price: 0.999 });
      expect(coins['#1540']).toMatchObject({ won: false, won_by: 'settlement' });
      expect(coins['#1550']).toMatchObject({ won: null, won_by: null, final_price: 0.6 });
      expect(coins['#1100']).toMatchObject({ won: true, won_by: 'final_price', final_price: 0.99991 });
      expect(coins['#1101']).toMatchObject({ won: false, won_by: 'final_price' });
      expect(coins['#3010']).toMatchObject({ won: true, won_by: 'final_price' });
      expect(coins['#3000']).toMatchObject({ won: false, won_by: 'final_price' });
      // The last trade, not the newer merge.
      expect(Date.now() - Date.parse(coins['#1100'].final_trade_at ?? '')).toBeGreaterThanOrEqual(3 * DAY);
      // A listed market and the residual outcome are never read.
      expect(Object.keys(coins).sort()).toEqual(['#1100', '#1101', '#1540', '#1541', '#1550', '#1551', '#3000', '#3010', '#3020']);
      expect(mockClient.getFills).toHaveBeenCalledTimes(9);
      // Only settled markets look for a settlement.
      expect(mockClient.getSettlements.mock.calls.map(([p]) => p.outcome_id).sort()).toEqual([154, 155]);
      expect(questions).toHaveBeenCalledWith({ limit: 200 });
    });

    it('trusts a settlement over last trades that point the other way', async () => {
      mockClient.getFills.mockImplementation(async ({ coin }: { coin: string }) =>
        [trade(coin, coin === '#1540' ? 0.999 : coin === '#1541' ? 0.001 : LAST_PX[coin], 3 * DAY)]
      );

      const { coins } = await svc.getResolutions();

      expect(coins['#1541']).toMatchObject({ won: true, won_by: 'settlement', final_price: 0.001 });
    });

    it('keeps the reads a week, a trade less than a day old an hour, an empty answer a day', async () => {
      mockClient.getFills.mockImplementation(async ({ coin }: { coin: string }) =>
        coin === '#3020' ? [] : tape(coin, coin === '#1100' ? 2 * HOUR : 3 * DAY)
      );

      await svc.getResolutions();

      expect(ttlOf('final-trade', '"#1101"')).toBe(HYPEDEXER_TTL.hip4FinalReads);
      expect(ttlOf('final-trade', '"#1100"')).toBe(HYPEDEXER_TTL.hip4DormantFills);
      expect(ttlOf('final-trade', '"#3020"')).toBe(HYPEDEXER_TTL.hip4SettledMarket);
      expect(ttlOf('settlement-of', ':154}')).toBe(HYPEDEXER_TTL.hip4FinalReads);
      expect(ttlOf('settlement-of', ':155}')).toBe(HYPEDEXER_TTL.hip4SettledMarket);
      expect(HYPEDEXER_TTL.hip4FinalReads).toBe(7 * 86400);
    });

    it('is one shared entry, recomputed hourly and kept 30 days', async () => {
      await svc.getResolutions();
      await svc.getResolutions();

      expect(questions).toHaveBeenCalledTimes(1);
      expect(mockRedis.ttls.get('hypedexer:hip4:resolutions:swr')).toBe(HYPEDEXER_TTL.hip4ResolutionsKeep);
      expect(HYPEDEXER_TTL.hip4Resolutions).toBe(3600);
    });

    it('fails, storing nothing, when outcomeMeta lists nothing or cannot be read', async () => {
      listOutcomes([]);
      await expect(svc.getResolutions()).rejects.toThrow();

      mockRedis.store.clear();
      listOutcomes('fail');
      await expect(svc.getResolutions()).rejects.toThrow();

      expect(mockRedis.store.has('hypedexer:hip4:resolutions:swr')).toBe(false);
      expect(mockClient.getFills).not.toHaveBeenCalled();
    });

    /** Ages the stored entry past its hour, then waits for the background recompute to store a new one. */
    async function recomputeStale(): Promise<Record<string, { won: boolean | null; final_price: number | null }>> {
      const key = 'hypedexer:hip4:resolutions:swr';
      const entry = JSON.parse(mockRedis.store.get(key) ?? '{}');
      mockRedis.store.set(key, JSON.stringify({ ...entry, at: Date.now() - 2 * HOUR }));
      await svc.getResolutions(); // serves the stale entry, recomputes in the background
      for (let i = 0; i < 100 && JSON.parse(mockRedis.store.get(key) ?? '{}').at < Date.now() - HOUR; i++) {
        await new Promise((r) => setImmediate(r));
      }
      return JSON.parse(mockRedis.store.get(key) ?? '{}').value.coins;
    }

    it('lets a failed read hold back only its market, read again at the next recompute', async () => {
      mockClient.getFills.mockImplementation(async ({ coin }: { coin: string }) => {
        if (coin === '#3020') throw new Error('HypeDexer 402');
        return tape(coin);
      });

      const { coins } = await svc.getResolutions();

      // Stored anyway: the other markets are named, the question with the failed coin is not yet.
      expect(mockRedis.store.has('hypedexer:hip4:resolutions:swr')).toBe(true);
      expect(coins['#1100']).toMatchObject({ won: true, won_by: 'final_price' });
      expect(coins['#3010']).toMatchObject({ won: null, won_by: null, final_price: 0.999 });
      expect(coins['#3020']).toMatchObject({ won: null, final_price: null });

      mockClient.getFills.mockClear();
      mockClient.getFills.mockImplementation(async ({ coin }: { coin: string }) => tape(coin));
      const next = await recomputeStale();

      expect(mockClient.getFills.mock.calls.map(([p]) => p.coin)).toEqual(['#3020']);
      expect(next['#3010']).toMatchObject({ won: true, won_by: 'final_price' });
    });

    it('keeps the last entry\'s winner for a market whose re-read fails', async () => {
      await svc.getResolutions();
      // A week later its keys expire and HypeDexer fails on one of them.
      for (const k of [...mockRedis.store.keys()]) if (k.includes('final-trade') && k.includes('#3020')) mockRedis.store.delete(k);
      mockClient.getFills.mockImplementation(async ({ coin }: { coin: string }) => {
        if (coin === '#3020') throw new Error('HypeDexer 402');
        return tape(coin);
      });

      const next = await recomputeStale();

      expect(next['#3010']).toMatchObject({ won: true, won_by: 'final_price' });
      expect(next['#3020']).toMatchObject({ won: false, final_price: 0 });
    });

    describe('while Redis is down', () => {
      afterEach(() => {
        mockRedis.isHealthy = () => true;
      });

      it('computes once, then serves that entry instead of ~270 reads per caller', async () => {
        mockRedis.isHealthy = () => false;

        const [a, b] = await Promise.all([svc.getResolutions(), svc.getResolutions()]);
        const c = await svc.getResolutions();

        expect(questions).toHaveBeenCalledTimes(1);
        expect(mockClient.getFills).toHaveBeenCalledTimes(9);
        expect(b).toBe(a);
        expect(c).toBe(a);
        expect(a.coins['#1100']).toMatchObject({ won: true });
      });

      it('does not let a caller over its budget compute it: reads refused one by one would leave a partial entry for everyone', async () => {
        mockRedis.isHealthy = () => false;
        const overBudget = new Promise<unknown>((resolve) => {
          void runWithUpstreamCaller(
            { ip: '6.6.6.6' } as Request,
            Object.assign(new EventEmitter(), {}) as unknown as Response,
            (() => resolve(svc.getResolutions().catch((error: unknown) => error))) as NextFunction,
            async () => ({ exhausted: true, retryAfterS: 9 })
          );
        });
        await expect(overBudget).resolves.toBeInstanceOf(UpstreamBudgetExceededError);
        expect(questions).not.toHaveBeenCalled();
        expect(mockClient.getFills).not.toHaveBeenCalled();

        // The next visitor computes the whole entry.
        const entry = await svc.getResolutions();
        expect(entry.coins['#1100']).toMatchObject({ won: true });
        expect(mockClient.getFills).toHaveBeenCalledTimes(9);
      });

      it('serves the entry it last had from Redis', async () => {
        const warm = await svc.getResolutions();
        mockRedis.isHealthy = () => false;

        expect(await svc.getResolutions()).toBe(warm);
        expect(questions).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('retries an empty metadata list sooner than a populated one', async () => {
    mockClient.getMarkets.mockResolvedValue([]);
    mockClient.getOutcomeTokens.mockResolvedValue([]);
    mockClient.getQuestions.mockResolvedValue([]);

    await svc.getMarketsEnriched();

    expect(storedTtl('hypedexer:hip4:markets')).toBe(HYPEDEXER_TTL.hip4BaseListRetry);
  });
});
