/**
 * Kiln graduations were never stored: the stream looked a graduation up with the keys a launch
 * trades under, and a Kiln launch trades on its curve while its graduation names its token
 * (468 graduations in the provider's logs, none in our table, 2026-11-11). The stream now
 * matches a graduation with the key its launch graduates under, and reads the history once.
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
import { ElysiumRpcLogs } from '../../../src/services/elysium/elysium-rpc-logs';
import { LAUNCHPAD_TOPICS, decodeLaunch, type LaunchRow } from '../../../src/services/elysium/elysium-launchpad.util';
import { toLaunchTokenView } from '../../../src/services/elysium/elysium-launchpad-market.service';
import type { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';
import fixtures from './fixtures/launchpads-2026-11-02.json';

const fx = fixtures as Record<string, Record<string, unknown>>;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const kilnLaunch = decodeLaunch(fx['0xcfc6745d:1']) as LaunchRow;
const kilnGraduated = fx['0xa2fff043:10'];

type Internals = {
  stopped: boolean;
  throttle: { wait: () => Promise<void> };
  rejects: IngestRejects;
  startedAt: number;
  launchStateFilled: boolean;
  launchStateHealed: boolean;
  head: { at: number; value: Date | null } | null;
  launchpadTick: () => Promise<number>;
};

describe('Elysium ingestion: Kiln graduations', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  let fetchPage: jest.SpyInstance;
  let findMarkets: jest.SpyInstance;
  let markGraduated: jest.SpyInstance;
  let advance: jest.SpyInstance;
  let states: Record<string, { cursor: Date | null; backfillDone: boolean } | undefined>;
  const asDb = (l: LaunchRow) => ({ token: l.token, launchpad: l.launchpad, kind: l.kind, curve: l.curve, pool: l.pool, quote: l.quote });
  const graduationQueries = () =>
    fetchPage.mock.calls.map((c) => c[1] as { topic0: string; start_time: string; end_time: string }).filter((q) => q.topic0 === LAUNCHPAD_TOPICS.kilnGraduated);

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    // The market state is another matter: done.
    svc.launchStateFilled = true;
    svc.launchStateHealed = true;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(client, 'fetchIngestHead').mockResolvedValue(new Date(NOW - 5_000));
    states = { launchpad: { cursor: new Date(NOW - 45_000), backfillDone: true }, kilngrads: { cursor: new Date(NOW), backfillDone: true } };
    jest.spyOn(repo, 'getState').mockImplementation(async (stream) => {
      const s = states[stream];
      return s ? { stream, cursor: s.cursor, rows: 0n, backfillDone: s.backfillDone, lastError: null, updatedAt: new Date(NOW) } : null;
    });
    // The provider returns the graduation for any window of its topic, unless a test says when it happened.
    fetchPage = jest.spyOn(client, 'fetchIngestPage').mockImplementation(async (_path, q) => ({
      rows: (q as { topic0?: string }).topic0 === LAUNCHPAD_TOPICS.kilnGraduated ? [kilnGraduated] : [],
      hasMore: false,
    }));
    findMarkets = jest.spyOn(repo, 'findLaunchMarkets').mockResolvedValue([asDb(kilnLaunch)]);
    markGraduated = jest.spyOn(repo, 'markGraduated').mockResolvedValue(1);
    advance = jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
    jest.spyOn(repo, 'insertLaunches').mockResolvedValue(0);
    jest.spyOn(repo, 'insertLaunchTrades').mockResolvedValue(0);
  });
  afterEach(() => jest.restoreAllMocks());

  it('marks the launch a Kiln graduation names by its token', async () => {
    await svc.launchpadTick();

    expect(findMarkets).toHaveBeenCalledWith(expect.arrayContaining([kilnLaunch.token]));
    expect(markGraduated).toHaveBeenCalledWith([
      expect.objectContaining({ token: kilnLaunch.token, curve: null, launchpad: 'Kiln', graduated_at: expect.any(String) }),
    ]);
    expect(svc.rejects.take()).toEqual([]);
  });

  it('does not let another pad’s launch of that address take a Kiln graduation, and counts it', async () => {
    findMarkets.mockResolvedValue([{ ...asDb(kilnLaunch), launchpad: 'Neuriio', curve: null }]);

    await svc.launchpadTick();

    expect(markGraduated).not.toHaveBeenCalled();
  });

  it('counts a Kiln graduation for a token that never launched here', async () => {
    findMarkets.mockResolvedValue([]);
    // A log the stream reads for the first time: it happened 30 s ago, after the cursor.
    const fresh = { ...kilnGraduated, block_time: iso(NOW - 30_000) };
    fetchPage.mockImplementation(async (_path, q) => ({
      rows: (q as { topic0?: string }).topic0 === LAUNCHPAD_TOPICS.kilnGraduated ? [fresh] : [],
      hasMore: false,
    }));

    await svc.launchpadTick();

    expect(markGraduated).not.toHaveBeenCalled();
    expect(svc.rejects.take()).toEqual([expect.objectContaining({ stream: 'launchpad', reason: 'market-unknown', count: 1 })]);
  });

  describe('the history, once', () => {
    beforeEach(() => {
      states.kilngrads = undefined;
    });

    it('reads the one topic from genesis to where the stream stands, marks the launches, and records that it is done', async () => {
      await svc.launchpadTick();

      const history = graduationQueries()[0];
      expect(history).toMatchObject({ start_time: '2026-09-11T11:55:00', end_time: iso(NOW - 45_000) });
      expect(advance).toHaveBeenCalledWith('kilngrads', { cursor: new Date(NOW - 45_000), setRows: 1, backfillDone: true });
      // The history, then the window of this tick.
      expect(markGraduated).toHaveBeenCalledTimes(2);
    });

    it('does not read it again once recorded, nor in the same process', async () => {
      await svc.launchpadTick();
      states.kilngrads = { cursor: new Date(NOW), backfillDone: true };
      fetchPage.mockClear();
      await svc.launchpadTick();
      expect(graduationQueries().every((q) => q.start_time !== '2026-09-11T11:55:00')).toBe(true);
    });

    it('waits for the stream’s own first backfill: that one reads everything itself', async () => {
      states.launchpad = { cursor: new Date(NOW - 45_000), backfillDone: false };
      await svc.launchpadTick();
      expect(advance).not.toHaveBeenCalledWith('kilngrads', expect.anything());
    });

    it('reads past the provider’s head from the RPC while the provider lags', async () => {
      // Provider stopped an hour ago; the launchpad stream went on from the RPC.
      (client.fetchIngestHead as jest.Mock).mockResolvedValue(new Date(NOW - 3_600_000));
      const rpc = jest.spyOn(ElysiumRpcLogs.getInstance(), 'getLogs').mockResolvedValue([]);

      await svc.launchpadTick();

      expect(graduationQueries()[0]).toMatchObject({ start_time: '2026-09-11T11:55:00', end_time: iso(NOW - 3_600_000) });
      expect(rpc).toHaveBeenCalledWith(LAUNCHPAD_TOPICS.kilnGraduated, new Date(NOW - 3_600_000), new Date(NOW - 45_000));
      expect(advance).toHaveBeenCalledWith('kilngrads', expect.objectContaining({ backfillDone: true }));
    });

    it('a failed read does not hold the stream: the window of the tick is still read, and the history is tried again later', async () => {
      let first = true;
      fetchPage.mockImplementation(async (_path, q) => {
        const query = q as { topic0?: string; start_time: string };
        if (first && query.topic0 === LAUNCHPAD_TOPICS.kilnGraduated && query.start_time === '2026-09-11T11:55:00') {
          first = false;
          throw new Error('API error: 503');
        }
        return { rows: [], hasMore: false };
      });

      await expect(svc.launchpadTick()).resolves.toBe(30_000);

      expect(advance).not.toHaveBeenCalledWith('kilngrads', expect.anything());
      expect(advance).toHaveBeenCalledWith('launchpad', expect.objectContaining({ cursor: new Date(NOW - 15_000) }));
      // Not again before 10 minutes.
      fetchPage.mockClear();
      await svc.launchpadTick();
      expect(graduationQueries().some((q) => q.start_time === '2026-09-11T11:55:00')).toBe(false);
    });
  });
});

describe('a graduated curve on the launchpad list', () => {
  const row = (over: Record<string, unknown>) =>
    ({ token: '0x' + 'a'.repeat(40), launchpad: 'Kiln', kind: 'curve', quote: '0x' + '0'.repeat(40), symbol: 'K', name: 'k', creator: null, price: 0.000001, sold: null, holders: 3, top10_pct: null, dev_pct: null, born: 1, graduated: false, ...over }) as never;

  it('shows a graduated Kiln token as full, and gives no share before that (its sale supply is not known)', () => {
    expect(toLaunchTokenView(row({ graduated: true }), 30)).toMatchObject({ graduated: true, curvePct: 100 });
    expect(toLaunchTokenView(row({ graduated: false }), 30)).toMatchObject({ graduated: false, curvePct: null });
  });

  it('keeps the share of the pads whose sale supply is known', () => {
    const half = (400_000_000n * 10n ** 18n).toString();
    expect(toLaunchTokenView(row({ launchpad: 'CorePad', sold: half }), 30).curvePct).toBeCloseTo(50, 6);
    expect(toLaunchTokenView(row({ launchpad: 'CorePad', sold: half, graduated: true }), 30).curvePct).toBe(100);
  });
});
