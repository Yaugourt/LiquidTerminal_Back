/**
 * How the ingestion pages a window (2026-11-11):
 * - the end of a window is what the provider says (`has_more`), not a page shorter than asked,
 *   and the next page starts after the rows received;
 * - a page that announces more and carries nothing fails the window (its cursor stays);
 * - a log window with more rows than the page cap is read again in halves, and is only ever
 *   cut at the smallest step, where the cut is counted.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { getClient: () => ({ set: jest.fn().mockResolvedValue('OK') }), delete: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import { ElysiumIngestionService } from '../../../src/services/elysium/elysium-ingestion.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';
import { HypeDexerElysiumIndexerClient } from '../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client';
import { DEX_TOPICS } from '../../../src/services/elysium/elysium-dex.util';
import type { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

type Internals = {
  stopped: boolean;
  throttle: { wait: () => Promise<void> };
  rejects: IngestRejects;
  dexStepMs: number;
  txTick: () => Promise<number>;
  dexTick: () => Promise<number>;
};

describe('Elysium ingestion: paging a window', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  let fetchPage: jest.SpyInstance;
  let advance: jest.SpyInstance;
  let insertTxs: jest.SpyInstance;
  let clock: number;

  const tx = (n: number) => ({
    tx_hash: `0x${n.toString(16).padStart(64, '0')}`,
    from_addr: `0x${'a'.repeat(40)}`,
    block_number: 100 + n,
    block_time: iso(NOW - 30_000),
    gas_used: 21000,
    effective_gas_price: 1,
    success: true,
  });
  const txs = (from: number, count: number) => Array.from({ length: count }, (_, i) => tx(from + i));
  const state = (stream: string, cursor: number | null, backfillDone: boolean) => ({
    stream,
    cursor: cursor === null ? null : new Date(cursor),
    rows: 0n,
    backfillDone,
    lastError: null,
    updatedAt: new Date(NOW),
  });
  const offsets = (path: string): number[] => fetchPage.mock.calls.filter((c) => c[0] === path).map((c) => (c[1] as { offset: number }).offset);

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.spyOn(client, 'fetchIngestHead').mockResolvedValue(new Date(NOW - 5_000));
    fetchPage = jest.spyOn(client, 'fetchIngestPage');
    advance = jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
    insertTxs = jest.spyOn(repo, 'insertTxs').mockImplementation(async (rows) => ({ inserted: rows.length, contracts: 0 }));
    jest.spyOn(repo, 'insertDexPools').mockResolvedValue(0);
    jest.spyOn(repo, 'insertDexSwaps').mockResolvedValue(0);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the end of a window', () => {
    beforeEach(() => jest.spyOn(repo, 'getState').mockResolvedValue(state('tx', NOW - 45_000, true)));

    it('goes on after a page the provider cut short, from the rows it did send', async () => {
      // 1,000 asked, 400 sent, and more to come: an old short page meant "done".
      fetchPage
        .mockResolvedValueOnce({ rows: txs(0, 400), hasMore: true })
        .mockResolvedValueOnce({ rows: txs(400, 1000), hasMore: true })
        .mockResolvedValueOnce({ rows: txs(1400, 37), hasMore: false });

      await svc.txTick();

      expect(offsets('/transactions')).toEqual([0, 400, 1400]);
      expect(insertTxs.mock.calls.reduce((n, c) => n + (c[0] as unknown[]).length, 0)).toBe(1437);
      expect(advance).toHaveBeenCalledWith('tx', expect.objectContaining({ cursor: new Date(NOW - 15_000), addRows: 1437 }));
    });

    it('stops at a full page when the provider says nothing is left', async () => {
      fetchPage.mockResolvedValueOnce({ rows: txs(0, 1000), hasMore: false });
      await svc.txTick();
      expect(offsets('/transactions')).toEqual([0]);
      expect(advance).toHaveBeenCalledTimes(1);
    });

    it('fails the window, and leaves the cursor, when a page announces more and carries nothing', async () => {
      fetchPage.mockResolvedValueOnce({ rows: txs(0, 1000), hasMore: true }).mockResolvedValueOnce({ rows: [], hasMore: true });
      await expect(svc.txTick()).rejects.toThrow('announced more rows and returned none');
      expect(advance).not.toHaveBeenCalled();
    });

    it('without the flag, a short page ends the window as before', async () => {
      fetchPage.mockResolvedValueOnce({ rows: txs(0, 1000), hasMore: null }).mockResolvedValueOnce({ rows: txs(1000, 12), hasMore: null });
      await svc.txTick();
      expect(offsets('/transactions')).toEqual([0, 1000]);
      expect(advance).toHaveBeenCalledTimes(1);
    });
  });

  describe('a log window over the page cap', () => {
    const swapTopic = DEX_TOPICS.v2Swap;
    /** v2 swaps never end inside a window longer than `fitsUnderMs`; every other topic is empty. */
    const serve = (fitsUnderMs: number): void => {
      fetchPage.mockImplementation(async (_path, q) => {
        const { topic0, start_time, end_time } = q as { topic0: string; start_time: string; end_time: string };
        const span = Date.parse(`${end_time}Z`) - Date.parse(`${start_time}Z`);
        if (topic0 !== swapTopic || span <= fitsUnderMs) return { rows: [], hasMore: false };
        return { rows: Array.from({ length: 1000 }, () => ({})), hasMore: true };
      });
    };
    const backfillFrom = NOW - 3 * DAY;

    it('reads the window again in halves instead of cutting it, and moves the cursor only over what it read whole', async () => {
      jest.spyOn(repo, 'getState').mockResolvedValue(state('dex', backfillFrom, false));
      // Each page read takes 1 ms of the 40 s a tick may run.
      serve(6 * 3_600_000);
      const served = fetchPage.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
      fetchPage.mockImplementation(async (...a: unknown[]) => {
        clock += 1;
        return served(...a);
      });

      await svc.dexTick();

      // 24 h and 12 h overflow (200 pages each, then given up); 6 h fits and is stored.
      const cursors = advance.mock.calls.filter((c) => c[0] === 'dex').map((c) => (c[1] as { cursor: Date }).cursor.getTime());
      expect(cursors[0]).toBe(backfillFrom + 6 * 3_600_000);
      expect(svc.rejects.take().filter((r) => r.reason === 'window-truncated')).toEqual([]);
    });

    it('cuts only at the smallest step, and counts it', async () => {
      jest.spyOn(repo, 'getState').mockResolvedValue(state('dex', backfillFrom, false));
      svc.dexStepMs = 60_000;
      serve(0);
      let reads = 0;
      const served = fetchPage.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
      fetchPage.mockImplementation(async (...a: unknown[]) => {
        // Stop the tick after its first window: the clock passes the tick's budget once the swaps are read.
        if (++reads > 202) clock = NOW + 60_000;
        return served(...a);
      });

      await svc.dexTick();

      expect(advance).toHaveBeenCalledWith('dex', expect.objectContaining({ cursor: new Date(backfillFrom + 60_000) }));
      const cuts = svc.rejects.take().filter((r) => r.reason === 'window-truncated');
      expect(cuts).toEqual([expect.objectContaining({ stream: 'dex', count: 1 })]);
      expect(cuts[0].sample).toContain('cut after 200000 rows');
    });
  });
});
