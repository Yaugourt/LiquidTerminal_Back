/**
 * IndexerHip4Service.getLiveVolumes: the volumes of every live outcome side in
 * one aggregate. The coin list is read from Hyperliquid outcomeMeta, split in
 * ≤256-char chunks read through getAnalytics, a chunk that fills a page is
 * split again, and a partial read is merged over the previous aggregate
 * keeping the larger value per coin.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getOrSet = jest.fn(async (_key: string, fetchFn: () => Promise<unknown>) => fetchFn());
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: { getOrSet: (...args: Parameters<typeof getOrSet>) => getOrSet(...args) },
  SHARED_LAST_COPY_KEEP_S: 3_600,
}));

const clientGetAnalytics = jest.fn();
jest.mock('../../../src/clients/hypedexer/rest/hip4/hip4.client', () => ({
  HypeDexerHip4Client: { getInstance: () => ({ getAnalytics: clientGetAnalytics }) },
}));

type Bucket = { bucket: string; coin: string; volume: number };
const bucket = (coin: number, volume: number): Bucket => ({ bucket: '2026-10-13', coin: `#${coin}`, volume });
const coinsOf = (call: unknown[]): number[] =>
  String((call[0] as { coin: string }).coin).split(',').map(Number);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const outcomeMeta = (outcomes: number[]): unknown => ({
  outcomes: outcomes.map((outcome) => ({ outcome, name: 'x' })),
  questions: [],
});

const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);

describe('IndexerHip4Service.getLiveVolumes', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let service: import('../../../src/services/indexer/indexer-hip4.service').IndexerHip4Service;
  let outcomes: number[];

  beforeEach(() => {
    jest.resetModules();
    getOrSet.mockClear();
    clientGetAnalytics.mockReset();
    outcomes = [6, 12];
    fetchMock = jest.fn(async () => json(outcomeMeta(outcomes)));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { IndexerHip4Service } = require('../../../src/services/indexer/indexer-hip4.service');
    service = IndexerHip4Service.getInstance();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('builds the coin list from outcomeMeta (sides 10N and 10N+1) and sums the daily buckets per coin', async () => {
    clientGetAnalytics.mockResolvedValue([bucket(60, 10), bucket(60, 5), bucket(61, 2), bucket(120, 7), bucket(121, 1)]);

    const live = await service.getLiveVolumes();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hyperliquid.xyz/info');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ type: 'outcomeMeta' });
    expect(clientGetAnalytics).toHaveBeenCalledTimes(1);
    expect(clientGetAnalytics).toHaveBeenCalledWith({ coin: '60,61,120,121', interval: '1d', limit: 2000 });
    expect(live.volumes).toEqual({ 60: 15, 61: 2, 120: 7, 121: 1 });
    expect(live.partial).toBe(false);
    expect(live.updatedAt).toBeGreaterThan(0);
  });

  it('ignores buckets without a readable coin and outcomes without a numeric id', async () => {
    fetchMock.mockResolvedValue(json({ outcomes: [{ outcome: 6 }, { name: 'no id' }, null], questions: [] }));
    clientGetAnalytics.mockResolvedValue([bucket(60, 1), { bucket: 'x', volume: 99 }, { bucket: 'x', coin: '#abc', volume: 99 }]);

    const live = await service.getLiveVolumes();

    expect(clientGetAnalytics).toHaveBeenCalledWith({ coin: '60,61', interval: '1d', limit: 2000 });
    expect(live.volumes).toEqual({ 60: 1 });
  });

  it('splits ~200 coins into ≤256-char chunks that cover every coin once, in order', async () => {
    outcomes = range(1000, 100);
    clientGetAnalytics.mockResolvedValue([]);

    await service.getLiveVolumes();

    const calls = clientGetAnalytics.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [params] of calls) expect((params as { coin: string }).coin.length).toBeLessThanOrEqual(256);
    const all = calls.flatMap(coinsOf);
    expect(all).toEqual(outcomes.flatMap((o) => [o * 10, o * 10 + 1]));
    // Chunks are filled up to the cap, not cut short.
    expect(calls[0][0].coin.length).toBeGreaterThan(245);
  });

  it('reads a chunk that fills a page again as two halves', async () => {
    const full = range(0, 2000).map(() => bucket(60, 1));
    clientGetAnalytics.mockImplementation(async (p: { coin: string }) => {
      if (p.coin === '60,61,120,121') return full;
      if (p.coin === '60,61') return [bucket(60, 100), bucket(61, 50)];
      if (p.coin === '120,121') return [bucket(120, 8), bucket(121, 4)];
      throw new Error(`unexpected ${p.coin}`);
    });

    const live = await service.getLiveVolumes();

    expect(clientGetAnalytics).toHaveBeenCalledTimes(3);
    expect(live.volumes).toEqual({ 60: 100, 61: 50, 120: 8, 121: 4 });
    expect(live.partial).toBe(false);
  });

  it('flags partial when a single coin still fills a page', async () => {
    outcomes = [6];
    clientGetAnalytics.mockImplementation(async (p: { coin: string }) => {
      if (p.coin === '60,61') return range(0, 2000).map(() => bucket(61, 1));
      if (p.coin === '60') return [bucket(60, 3)];
      if (p.coin === '61') return range(0, 2000).map(() => bucket(61, 1));
      throw new Error(`unexpected ${p.coin}`);
    });

    const live = await service.getLiveVolumes();

    expect(live.partial).toBe(true);
    expect(live.volumes).toEqual({ 60: 3, 61: 2000 });
  });

  it('keeps the truncated page rows of a half that fails and flags partial', async () => {
    outcomes = [6];
    const page = [...range(0, 1990).map(() => bucket(60, 1)), ...range(0, 10).map(() => bucket(61, 5))];
    expect(page).toHaveLength(2000);
    clientGetAnalytics
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error('half down'))
      .mockResolvedValueOnce([bucket(61, 77)]);

    const live = await service.getLiveVolumes();

    expect(live.partial).toBe(true);
    // The failing half (coin 60) keeps its rows of the cut-off page, the other half is read in full.
    expect(live.volumes).toEqual({ 60: 1990, 61: 77 });
  });

  it('is partial when one chunk fails, and the others still count', async () => {
    outcomes = range(1000, 100);
    clientGetAnalytics.mockImplementation(async (p: { coin: string }) => {
      if (p.coin.startsWith('10000,')) throw new Error('402');
      return p.coin.split(',').map((c) => bucket(Number(c), 1));
    });

    const live = await service.getLiveVolumes();

    expect(live.partial).toBe(true);
    expect(live.volumes[10000]).toBeUndefined();
    expect(live.volumes[10990]).toBe(1);
  });

  it('throws when every chunk fails, so the cache serves its last copy', async () => {
    outcomes = range(1000, 100);
    clientGetAnalytics.mockRejectedValue(new Error('402 Payment Required'));

    await expect(service.getLiveVolumes()).rejects.toThrow('402 Payment Required');
  });

  it('counts an analytics answer that is not a list as a failed chunk', async () => {
    clientGetAnalytics.mockResolvedValue({ error: 'nope' });

    await expect(service.getLiveVolumes()).rejects.toThrow('Unexpected HIP-4 analytics payload');
  });

  it('throws when outcomeMeta cannot be read', async () => {
    fetchMock.mockResolvedValue(json({}, 429));
    await expect(service.getLiveVolumes()).rejects.toThrow('outcomeMeta answered 429');

    fetchMock.mockResolvedValue(json({ questions: [] }));
    await expect(service.getLiveVolumes()).rejects.toThrow('Unexpected outcomeMeta payload');
    expect(clientGetAnalytics).not.toHaveBeenCalled();
  });

  it('answers an empty aggregate, without reading the indexer, while there are no outcomes', async () => {
    outcomes = [];

    const live = await service.getLiveVolumes();

    expect(live).toMatchObject({ volumes: {}, partial: false });
    expect(clientGetAnalytics).not.toHaveBeenCalled();
  });

  describe('partial reads', () => {
    beforeEach(() => {
      outcomes = range(1000, 100);
    });

    const everyCoinReads = (volumeOf: (coin: number) => number, failing?: string) =>
      async (p: { coin: string }) => {
        if (failing && p.coin.startsWith(failing)) throw new Error('boom');
        return p.coin.split(',').map((c) => bucket(Number(c), volumeOf(Number(c))));
      };

    it('merges over the previous aggregate keeping the larger value per coin', async () => {
      clientGetAnalytics.mockImplementation(everyCoinReads(() => 100));
      const first = await service.getLiveVolumes();
      expect(first.partial).toBe(false);

      // Second read: the first chunk fails, every other coin grew but 10990 went down.
      clientGetAnalytics.mockImplementation(async (p: { coin: string }) => {
        if (p.coin.startsWith('10000,')) throw new Error('boom');
        return p.coin.split(',').map((c) => bucket(Number(c), c === '10990' ? 40 : 150));
      });
      const second = await service.getLiveVolumes();

      expect(second.volumes[10000]).toBe(100); // failed chunk: previous value kept
      expect(second.volumes[10990]).toBe(100); // fresh 40 < previous 100: the larger stays
      expect(second.volumes[10980]).toBe(150); // fresh 150 > previous 100: grew
      expect(second.partial).toBe(false); // a complete read stands behind it
    });

    it('stands as it is when no aggregate came before', async () => {
      clientGetAnalytics.mockImplementation(everyCoinReads(() => 7, '10000,'));

      const live = await service.getLiveVolumes();

      expect(live.partial).toBe(true);
      expect(live.volumes[10000]).toBeUndefined();
      expect(live.volumes[10980]).toBe(7);
    });

    it('stays partial when the aggregate it is merged over was partial too', async () => {
      clientGetAnalytics.mockImplementation(everyCoinReads(() => 7, '10000,'));
      await service.getLiveVolumes();

      clientGetAnalytics.mockImplementation(everyCoinReads(() => 9, '10000,'));
      const second = await service.getLiveVolumes();

      expect(second.partial).toBe(true);
      expect(second.volumes[10980]).toBe(9);
    });

    it('replaces the previous aggregate by a complete read, even a lower one', async () => {
      clientGetAnalytics.mockImplementation(everyCoinReads(() => 100));
      await service.getLiveVolumes();

      clientGetAnalytics.mockImplementation(everyCoinReads(() => 60));
      const second = await service.getLiveVolumes();

      expect(second.volumes[10980]).toBe(60);
    });
  });

  describe('cache wiring', () => {
    it('shares the aggregate under one key for 15 s with its last copy served in the background', async () => {
      clientGetAnalytics.mockResolvedValue([]);

      await service.getLiveVolumes();

      const aggregate = getOrSet.mock.calls.find(([key]) => key === 'hypedexer:hip4:live-volumes');
      expect(aggregate).toBeDefined();
      expect(aggregate?.[2]).toBe(15);
      expect(aggregate?.[3]).toEqual({ lastCopy: true, refreshInBackground: true });
    });

    it('keeps outcomeMeta ids a minute under a fixed key, and reads chunks through the per-chunk analytics key', async () => {
      clientGetAnalytics.mockResolvedValue([]);

      await service.getLiveVolumes();

      const meta = getOrSet.mock.calls.find(([key]) => key === 'hyperliquid:hip4:outcome-ids');
      expect(meta?.[2]).toBe(60);
      const chunk = getOrSet.mock.calls.find(([key]) => String(key).startsWith('hypedexer:hip4:analytics:'));
      expect(chunk?.[0]).toBe(
        'hypedexer:hip4:analytics:{"coin":"60,61,120,121","interval":"1d","limit":2000}'
      );
      expect(chunk?.[2]).toBe(15);
    });
  });
});
