/**
 * What the ingestion asks the provider for, since 2026-11-10:
 * - a time stream never reads past the provider's head, reads the head again when the one it knows
 *   has not reached the time it wants, and re-reads 20 s before its cursor (it was 120 s);
 * - the token stream reads the head of the listing on every run and a slice of the rest, resuming
 *   where the last run stopped, and is scheduled from start to start;
 * - the holder stats stream asks for its targets with the new and the traded launches first.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/core/redis.service', () => ({ redisService: { getClient: jest.fn(), delete: jest.fn() } }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import { ElysiumIngestionService } from '../../../src/services/elysium/elysium-ingestion.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';
import { HypeDexerElysiumIndexerClient } from '../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

type Internals = {
  stopped: boolean;
  throttle: { wait: () => Promise<void> };
  head: { at: number; value: Date | null } | null;
  txTick: () => Promise<number>;
  tokensTick: () => Promise<number>;
  launchStatsTick: () => Promise<number>;
};

describe('Elysium ingestion: what it asks the provider', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  let fetchHead: jest.SpyInstance;
  let fetchPage: jest.SpyInstance;
  let advance: jest.SpyInstance;
  let getState: jest.SpyInstance;

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    fetchHead = jest.spyOn(client, 'fetchIngestHead');
    fetchPage = jest.spyOn(client, 'fetchIngestPage').mockResolvedValue([]);
    advance = jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
    getState = jest.spyOn(repo, 'getState');
    jest.spyOn(repo, 'insertTxs').mockResolvedValue({ inserted: 0, contracts: 0 });
  });
  afterEach(() => jest.restoreAllMocks());

  const liveState = (cursorMs: number) => ({ stream: 'tx', cursor: new Date(cursorMs), rows: 0n, backfillDone: true, lastError: null, updatedAt: new Date(NOW) });
  const txWindow = (): { start_time: string; end_time: string } => fetchPage.mock.calls.find((c) => c[0] === '/transactions')?.[1];

  describe('tx stream', () => {
    it('re-reads 20 s before its cursor and stops 15 s short of now when the provider is current', async () => {
      getState.mockResolvedValue(liveState(NOW - 45_000));
      fetchHead.mockResolvedValue(new Date(NOW - 6_000));

      await svc.txTick();

      expect(txWindow()).toMatchObject({ start_time: iso(NOW - 65_000), end_time: iso(NOW - 15_000) });
      expect(advance).toHaveBeenCalledWith('tx', expect.objectContaining({ cursor: new Date(NOW - 15_000) }));
    });

    it('stops 3 s short of the head when the provider is late, so no row is left behind the cursor', async () => {
      getState.mockResolvedValue(liveState(NOW - 90_000));
      fetchHead.mockResolvedValue(new Date(NOW - 40_000));

      await svc.txTick();

      expect(txWindow()).toMatchObject({ start_time: iso(NOW - 110_000), end_time: iso(NOW - 43_000) });
      expect(advance).toHaveBeenCalledWith('tx', expect.objectContaining({ cursor: new Date(NOW - 43_000) }));
    });

    it('reads nothing, and leaves its cursor, while the head has not passed it', async () => {
      getState.mockResolvedValue(liveState(NOW - 45_000));
      fetchHead.mockResolvedValue(new Date(NOW - 46_000));

      await svc.txTick();

      expect(fetchPage).not.toHaveBeenCalled();
      expect(advance).not.toHaveBeenCalled();
    });

    it('reads the head again when the one it knows has not reached the time it wants', async () => {
      getState.mockResolvedValue(liveState(NOW - 45_000));
      // Known 10 s ago, 26 s behind the clock: short of now - 15 s.
      svc.head = { at: NOW - 10_000, value: new Date(NOW - 26_000) };
      fetchHead.mockResolvedValue(new Date(NOW - 5_000));

      await svc.txTick();

      expect(fetchHead).toHaveBeenCalledTimes(1);
      expect(txWindow().end_time).toBe(iso(NOW - 15_000));
    });

    it('keeps a head that already covers the window, and one read under 5 s ago', async () => {
      getState.mockResolvedValue(liveState(NOW - 45_000));
      svc.head = { at: NOW - 10_000, value: new Date(NOW - 11_000) };
      await svc.txTick();
      expect(fetchHead).not.toHaveBeenCalled();
      expect(txWindow().end_time).toBe(iso(NOW - 15_000));

      fetchPage.mockClear();
      getState.mockResolvedValue(liveState(NOW - 45_000));
      svc.head = { at: NOW - 4_000, value: new Date(NOW - 30_000) };
      await svc.txTick();
      expect(fetchHead).not.toHaveBeenCalled();
      expect(txWindow().end_time).toBe(iso(NOW - 33_000));
    });

    it('falls back to the clock when the head cannot be read at all', async () => {
      getState.mockResolvedValue(liveState(NOW - 45_000));
      fetchHead.mockRejectedValue(new Error('HTTP 503'));
      await svc.txTick();
      expect(txWindow().end_time).toBe(iso(NOW - 15_000));
    });
  });

  describe('token stream', () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ address: '0x' + String(i).padStart(40, '0'), standard: 'erc20', transfer_count: 3 }));
    let upsert: jest.SpyInstance;
    const offsets = (): number[] => fetchPage.mock.calls.map((c) => (c[1] as { offset: number }).offset / 1000);

    beforeEach(() => {
      upsert = jest.spyOn(repo, 'upsertTokens').mockResolvedValue(0);
      jest.spyOn(repo, 'nameLaunches').mockResolvedValue(0);
      fetchPage.mockResolvedValue(page(1000));
    });

    it('reads the 20 head pages, then 20 pages from where the last run stopped', async () => {
      getState.mockResolvedValue({ stream: 'tokenstail', cursor: null, rows: 140n, backfillDone: false, lastError: null, updatedAt: new Date(NOW) });

      await svc.tokensTick();

      expect(offsets()).toEqual([...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 20 }, (_, i) => 140 + i)]);
      expect(fetchPage.mock.calls[0]).toEqual(['/tokens', { standard: 'erc20', limit: 1000, offset: 0 }]);
      expect(upsert).toHaveBeenCalledTimes(40);
      expect(advance).toHaveBeenCalledWith('tokenstail', { cursor: expect.any(Date), setRows: 160 });
      expect(advance).toHaveBeenCalledWith('tokens', { cursor: expect.any(Date), setRows: 40_000, backfillDone: true });
    });

    it('starts the walk right after the head when it never ran', async () => {
      getState.mockResolvedValue(null);
      await svc.tokensTick();
      expect(offsets().slice(20)).toEqual(Array.from({ length: 20 }, (_, i) => 20 + i));
    });

    it('goes back to the first page after the head once the listing ends', async () => {
      getState.mockResolvedValue({ stream: 'tokenstail', cursor: null, rows: 500n, backfillDone: false, lastError: null, updatedAt: new Date(NOW) });
      // The listing ends on its 503rd page.
      fetchPage.mockImplementation(async (_path, q) => page((q as { offset: number }).offset === 502_000 ? 412 : 1000));

      await svc.tokensTick();

      expect(offsets().slice(20)).toEqual([500, 501, 502]);
      expect(advance).toHaveBeenCalledWith('tokenstail', { cursor: expect.any(Date), setRows: 20, backfillDone: true });
      expect(advance).toHaveBeenCalledWith('tokens', expect.objectContaining({ setRows: 22_412 }));
    });

    it('keeps reading the registry when naming launches from a page fails', async () => {
      getState.mockResolvedValue(null);
      const name = jest.spyOn(repo, 'nameLaunches').mockRejectedValue(new Error('deadlock detected'));
      await expect(svc.tokensTick()).resolves.toBeGreaterThan(0);
      expect(name).toHaveBeenCalledTimes(40);
      expect(upsert).toHaveBeenCalledTimes(40);
      expect(advance).toHaveBeenCalledWith('tokens', expect.objectContaining({ setRows: 40_000 }));
    });

    it('is scheduled from start to start: 15 min less what the run took, at least a minute', async () => {
      getState.mockResolvedValue(null);
      let clock = NOW;
      (Date.now as jest.Mock).mockImplementation(() => clock);
      fetchPage.mockImplementation(async () => {
        clock += 10_000; // a page takes 10 s
        return page(1000);
      });
      expect(await svc.tokensTick()).toBe(15 * 60_000 - 400_000);

      fetchPage.mockImplementation(async () => {
        clock += 30_000;
        return page(1000);
      });
      expect(await svc.tokensTick()).toBe(60_000);
    });
  });

  it('holder stats: asks for a batch of 60, 40 of them for the new and the traded launches', async () => {
    const list = jest.spyOn(repo, 'listLaunchesForStats').mockResolvedValue([]);
    await svc.launchStatsTick();
    expect(list).toHaveBeenCalledWith(60, 40, 30 * 60, 14 * 60);
  });
});
