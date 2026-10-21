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

  it('retries an empty metadata list sooner than a populated one', async () => {
    mockClient.getMarkets.mockResolvedValue([]);
    mockClient.getOutcomeTokens.mockResolvedValue([]);
    mockClient.getQuestions.mockResolvedValue([]);

    await svc.getMarketsEnriched();

    expect(storedTtl('hypedexer:hip4:markets')).toBe(HYPEDEXER_TTL.hip4BaseListRetry);
  });
});
