/**
 * The bridge stream (2026-11-11):
 * - its cursor is what the provider has indexed, not the time of the run, and what lies between
 *   the cursor and the live window is read before anything else: after a provider outage longer
 *   than the 26 h window, the transfers begun in between were never read;
 * - withdrawals executed more than 8 days after their request were never updated (one in ten):
 *   each wide run reads one more day of older executed withdrawals, walking back 90 days;
 * - a deposit still waiting for its ticket after 26 h is read again by its hash.
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
import type { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const HASH = (c: string): string => `0x${c.repeat(64)}`;

type Internals = {
  stopped: boolean;
  throttle: { wait: () => Promise<void> };
  rejects: IngestRejects;
  lastBridgeWideAt: number;
  head: { at: number; value: Date | null } | null;
  bridgeTick: () => Promise<number>;
};
type Query = { start_time: string; end_time: string; status?: string; direction?: string };

describe('Elysium ingestion: bridge stream', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  let clock: number;
  let fetchHead: jest.SpyInstance;
  let fetchPage: jest.SpyInstance;
  let advance: jest.SpyInstance;
  let openDeposits: jest.SpyInstance;
  let states: Record<string, { cursor: number | null; rows?: number; backfillDone?: boolean } | undefined>;
  const queries = (): Query[] => fetchPage.mock.calls.map((c) => c[1] as Query);
  const plain = (): Query[] => queries().filter((q) => !q.status);
  const cursors = (): number[] => advance.mock.calls.filter((c) => c[0] === 'bridge').map((c) => (c[1] as { cursor: Date }).cursor.getTime());
  /** Not a wide run: the 26 h window and the sweeps ran a minute ago. */
  const narrow = (): void => {
    svc.lastBridgeWideAt = clock - MIN;
  };

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    fetchHead = jest.spyOn(client, 'fetchIngestHead').mockImplementation(async () => new Date(clock - 5_000));
    fetchPage = jest.spyOn(client, 'fetchIngestPage').mockResolvedValue({ rows: [], hasMore: false });
    advance = jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
    jest.spyOn(repo, 'upsertBridgeTransfers').mockImplementation(async (rows) => rows.length);
    openDeposits = jest.spyOn(repo, 'listOpenDeposits').mockResolvedValue([]);
    states = { bridge: { cursor: NOW - MIN, backfillDone: true } };
    jest.spyOn(repo, 'getState').mockImplementation(async (stream) => {
      const s = states[stream];
      if (!s) return null;
      return { stream, cursor: s.cursor === null ? null : new Date(s.cursor), rows: BigInt(s.rows ?? 0), backfillDone: s.backfillDone ?? false, lastError: null, updatedAt: new Date(NOW) };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the cursor and the live window', () => {
    it('a run a minute after the last one reads the last 15 minutes, once, and moves the cursor to now', async () => {
      narrow();
      await svc.bridgeTick();
      expect(queries()).toEqual([{ start_time: iso(NOW - 15 * MIN), end_time: iso(NOW), limit: 1000, offset: 0 }]);
      expect(cursors()).toEqual([NOW]);
    });

    it('while the provider lags, the cursor is its head, not the clock', async () => {
      narrow();
      const head = NOW - 2 * HOUR;
      fetchHead.mockResolvedValue(new Date(head));

      await svc.bridgeTick();

      // Nothing of the last 15 minutes is indexed: not read. The cursor comes back to the head.
      expect(queries()).toEqual([]);
      expect(cursors()).toEqual([head]);
    });

    it('during a stall, reads the 15 minutes before the head once, not on every run', async () => {
      narrow();
      const head = NOW - 2 * HOUR;
      fetchHead.mockResolvedValue(new Date(head));
      states.bridge = { cursor: head, backfillDone: true };

      await svc.bridgeTick();
      expect(plain().map((q) => [q.start_time, q.end_time])).toEqual([[iso(head - 15 * MIN), iso(head)]]);

      fetchPage.mockClear();
      clock += MIN;
      svc.head = null;
      narrow();
      await svc.bridgeTick();
      expect(queries()).toEqual([]);
      expect(cursors().every((c) => c === head)).toBe(true);
    });

    it('when the provider moves on, reads what it indexed since, from the cursor', async () => {
      narrow();
      const stalledAt = NOW - 30 * HOUR;
      const head = NOW - 20 * HOUR;
      fetchHead.mockResolvedValue(new Date(head));
      states.bridge = { cursor: stalledAt, backfillDone: true };

      await svc.bridgeTick();

      expect(plain().map((q) => [q.start_time, q.end_time])).toEqual([
        [iso(stalledAt - 15 * MIN), iso(stalledAt - 15 * MIN + 6 * HOUR)],
        [iso(stalledAt - 15 * MIN + 6 * HOUR), iso(head)],
      ]);
      expect(cursors()).toEqual([stalledAt - 15 * MIN + 6 * HOUR, head, head]);
    });

    it('after 3 days without a run, reads the whole gap in 6 h steps before the 26 h window (it used to read the 26 h only)', async () => {
      const last = NOW - 3 * DAY;
      states.bridge = { cursor: last, backfillDone: true };

      await svc.bridgeTick();

      const steps = plain().map((q) => [Date.parse(`${q.start_time}Z`), Date.parse(`${q.end_time}Z`)]);
      const live = steps.pop() as number[];
      expect(live).toEqual([NOW - 26 * HOUR, NOW]);
      // The gap: from 15 minutes before the cursor to the start of the 26 h window, without a hole.
      expect(steps[0][0]).toBe(last - 15 * MIN);
      expect(steps[steps.length - 1][1]).toBe(NOW - 26 * HOUR);
      for (let i = 1; i < steps.length; i++) expect(steps[i][0]).toBe(steps[i - 1][1]);
      expect(steps.every(([a, b]) => b - a <= 6 * HOUR)).toBe(true);
      expect(cursors()[cursors().length - 1]).toBe(NOW);
    });

    it('out of time in the middle of a gap: stops there, says so with its cursor, and asks to run again at once', async () => {
      narrow();
      states.bridge = { cursor: NOW - 10 * DAY, backfillDone: true };
      // Each window read takes 15 s of the 40 s a run may take.
      fetchPage.mockImplementation(async () => {
        clock += 15_000;
        return { rows: [], hasMore: false };
      });

      expect(await svc.bridgeTick()).toBe(0);

      const from = NOW - 10 * DAY - 15 * MIN;
      expect(cursors()).toEqual([from + 6 * HOUR, from + 12 * HOUR, from + 18 * HOUR]);
      // No live read on this run: the gap comes first.
      expect(plain()).toHaveLength(3);
    });
  });

  describe('withdrawals executed long after their request', () => {
    const executed = (): Query[] => queries().filter((q) => q.status === 'executed');

    it('a wide run reads the 8 days, then one day of older ones, and moves the walk on', async () => {
      states.bridgedeep = { cursor: NOW - 15 * MIN, rows: 23 };

      await svc.bridgeTick();

      expect(executed().map((q) => [q.direction, q.start_time, q.end_time])).toEqual([
        ['withdrawal', iso(NOW - 8 * DAY), iso(NOW)],
        ['withdrawal', iso(NOW - 24 * DAY), iso(NOW - 23 * DAY)],
      ]);
      expect(advance).toHaveBeenCalledWith('bridgedeep', { cursor: new Date(NOW), setRows: 24 });
    });

    it('starts the walk at the day after the 8-day sweep', async () => {
      await svc.bridgeTick();
      expect(executed()[1]).toMatchObject({ start_time: iso(NOW - 9 * DAY), end_time: iso(NOW - 8 * DAY) });
      expect(advance).toHaveBeenCalledWith('bridgedeep', { cursor: new Date(NOW), setRows: 9 });
    });

    it('stops at the chain’s first day and starts over', async () => {
      // Genesis is 2026-09-11T11:55, 61 days and 5 minutes before this clock: the slice 61 days
      // back holds the chain's first 5 minutes, and is the last one.
      states.bridgedeep = { cursor: NOW - 15 * MIN, rows: 61 };
      await svc.bridgeTick();
      expect(executed()[1]).toMatchObject({ start_time: iso(NOW - 62 * DAY), end_time: iso(NOW - 61 * DAY) });
      expect(advance).toHaveBeenCalledWith('bridgedeep', { cursor: new Date(NOW), setRows: 8, backfillDone: true });
    });

    it('starts over from a position that is past the end (a marker written by an older chain age or by hand)', async () => {
      states.bridgedeep = { cursor: NOW - 15 * MIN, rows: 400 };
      await svc.bridgeTick();
      expect(executed()[1]).toMatchObject({ start_time: iso(NOW - 9 * DAY), end_time: iso(NOW - 8 * DAY) });
    });

    it('never walks back more than 90 days, however old the chain', async () => {
      clock = Date.parse('2027-06-01T00:00:00Z');
      states.bridge = { cursor: clock - MIN, backfillDone: true };
      states.bridgedeep = { cursor: clock - 15 * MIN, rows: 89 };
      await svc.bridgeTick();
      expect(executed()[1]).toMatchObject({ start_time: iso(clock - 90 * DAY), end_time: iso(clock - 89 * DAY) });
      expect(advance).toHaveBeenCalledWith('bridgedeep', { cursor: new Date(clock), setRows: 8, backfillDone: true });
    });

    it('a run that is not wide reads none of it', async () => {
      narrow();
      await svc.bridgeTick();
      expect(executed()).toEqual([]);
      expect(openDeposits).not.toHaveBeenCalled();
    });
  });

  describe('deposits still waiting for their ticket', () => {
    const transfer = (id: string, status: string) => ({ transfer_id: id, direction: 'deposit', status, initiated_time: iso(NOW - 3 * DAY), l1_tx_hash: HASH('a') });
    let byHash: jest.SpyInstance;
    beforeEach(() => {
      byHash = jest.spyOn(client, 'fetchIngestBridgeTransfers');
    });

    it('reads each again by its hash and stores what the provider says now', async () => {
      openDeposits.mockResolvedValue([{ transfer_id: 'd:1', tx_hash: HASH('a') }]);
      byHash.mockResolvedValue([transfer('d:1', 'completed')]);

      await svc.bridgeTick();

      // Older than the 26 h window, younger than 10 days, 25 at most.
      expect(openDeposits).toHaveBeenCalledWith(26 * 3600, 10 * 24 * 3600, 25, 0);
      expect(byHash).toHaveBeenCalledWith(HASH('a'));
      expect(repo.upsertBridgeTransfers).toHaveBeenCalledWith([expect.objectContaining({ transfer_id: 'd:1', status: 'completed' })]);
    });

    it('goes past one that cannot be read, and counts it', async () => {
      openDeposits.mockResolvedValue([
        { transfer_id: 'd:1', tx_hash: HASH('a') },
        { transfer_id: 'd:2', tx_hash: HASH('b') },
      ]);
      byHash.mockRejectedValueOnce(new Error('API error: 404')).mockResolvedValueOnce([transfer('d:2', 'expired')]);

      await svc.bridgeTick();

      expect(repo.upsertBridgeTransfers).toHaveBeenCalledWith([expect.objectContaining({ transfer_id: 'd:2', status: 'expired' })]);
      expect(svc.rejects.take()).toEqual([
        { stream: 'bridge', reason: 'transfer-unreadable', count: 1, sample: 'd:1 API error: 404' },
      ]);
      expect(cursors()).toEqual([NOW]);
    });

    it('walks through them when there are more than a sweep reads, then starts over', async () => {
      const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ transfer_id: `d:${from + i}`, tx_hash: HASH('a') }));
      byHash.mockResolvedValue([]);
      openDeposits.mockResolvedValueOnce(batch(0, 25)).mockResolvedValueOnce(batch(25, 4)).mockResolvedValueOnce(batch(0, 25));

      for (let i = 0; i < 3; i++) {
        svc.lastBridgeWideAt = 0;
        await svc.bridgeTick();
      }

      expect(openDeposits.mock.calls.map((c) => c[3])).toEqual([0, 25, 0]);
    });
  });
});
