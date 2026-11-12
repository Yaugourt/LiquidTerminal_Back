/**
 * The V2 and V3 swap logs were read from the provider by two streams for the same seconds: the
 * DEX stream for its swaps table, the launchpad stream for the trades of the launches that
 * moved to a pair or a pool (2,880 calls a day, every swap billed twice; 2026-11-12). The
 * launchpad stream, which reads them every 30 s, now stores them as DEX swaps too, and the DEX
 * stream reads them itself only where the launchpad stream has not.
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
import { LAUNCHPAD_TOPICS } from '../../../src/services/elysium/elysium-launchpad.util';

const T0 = Date.parse('2026-11-12T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const SWAP_TOPICS = [DEX_TOPICS.v2Swap, DEX_TOPICS.v3Swap] as string[];

/** A real V2 swap log of the testnet (upstream /logs), at the time given. */
const swapAt = (ms: number, n: number): Record<string, unknown> => ({
  block_time: iso(ms),
  block_number: 579265 + n,
  log_index: n,
  tx_hash: `0xce233c7422fa5d8dca89fa7feb0643460c36ed22a991a7f33ffe2316${n.toString(16).padStart(8, '0')}`,
  address: '0x7062fdaabb95a25f3821539b4f8688dc5fc77356',
  topic0: DEX_TOPICS.v2Swap,
  topic1: '0x0000000000000000000000001e4f06e89a0c4f0c47f42a78881c8ee357dd628e',
  topic2: '0x000000000000000000000000b23e2d323e6fbd008618bf3970881107f2bfd580',
  topic3: '',
  data:
    '0x00000000000000000000000000000000000000000000000000235978e783e000' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000013d4e6067d4497721dcdf8',
});

type Internals = {
  stopped: boolean;
  throttle: { wait: () => Promise<void> };
  launchStateFilled: boolean;
  launchStateHealed: boolean;
  kilnHistoryDone: boolean;
  swapsFed: { from: number; to: number } | null;
  dexSwapsDue: number | null;
  launchpadStepMs: number;
  dexTick: () => Promise<number>;
  launchpadTick: () => Promise<number>;
};

describe('Elysium ingestion: the V2 and V3 swaps are read once for both streams', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  let clock: number;
  let fetchPage: jest.SpyInstance;
  let insertSwaps: jest.SpyInstance;
  let advance: jest.SpyInstance;
  let states: Record<string, { cursor: Date | null; backfillDone: boolean }>;
  /** Every swap log the provider holds; a window gets the ones of its seconds. */
  let swaps: Array<Record<string, unknown>>;
  /** The provider's /logs calls of a stream's tick: [topic0, start, end]. */
  let calls: Array<{ topic0: string; start: string; end: string }>;
  const swapCalls = () => calls.filter((c) => SWAP_TOPICS.includes(c.topic0));
  /** Runs a stream's tick at `at` and returns the swap reads it made. */
  const tick = async (stream: 'dex' | 'launchpad', at: number): Promise<Array<{ topic0: string; start: string; end: string }>> => {
    clock = at;
    calls = [];
    await (stream === 'dex' ? svc.dexTick() : svc.launchpadTick());
    return swapCalls();
  };
  const stored = (): string[] => insertSwaps.mock.calls.flatMap((c) => (c[0] as Array<{ tx_hash: string }>).map((r) => r.tx_hash));

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    svc.launchStateFilled = true;
    svc.launchStateHealed = true;
    svc.kilnHistoryDone = true;
    clock = T0;
    swaps = [];
    calls = [];
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.spyOn(client, 'fetchIngestHead').mockImplementation(async () => new Date(clock - 5_000));
    // Both streams live, their cursors where a run 60 s (dex) and 30 s (launchpad) earlier left them.
    states = {
      dex: { cursor: new Date(T0 - 75_000), backfillDone: true },
      launchpad: { cursor: new Date(T0 - 45_000), backfillDone: true },
    };
    jest.spyOn(repo, 'getState').mockImplementation(async (stream) => {
      const s = states[stream];
      return s ? { stream, cursor: s.cursor, rows: 0n, backfillDone: s.backfillDone, lastError: null, updatedAt: new Date(clock), okAt: null } : null;
    });
    advance = jest.spyOn(repo, 'advance').mockImplementation(async (stream, patch) => {
      const s = states[stream];
      if (s && patch.cursor) s.cursor = patch.cursor;
    });
    fetchPage = jest.spyOn(client, 'fetchIngestPage').mockImplementation(async (_path, query) => {
      const q = query as unknown as { topic0: string; start_time: string; end_time: string };
      calls.push({ topic0: q.topic0, start: q.start_time, end: q.end_time });
      const rows = q.topic0 === DEX_TOPICS.v2Swap ? swaps.filter((s) => String(s.block_time) >= q.start_time && String(s.block_time) <= q.end_time) : [];
      return { rows, hasMore: false };
    });
    insertSwaps = jest.spyOn(repo, 'insertDexSwaps').mockImplementation(async (rows) => rows.length);
    jest.spyOn(repo, 'insertDexPools').mockResolvedValue(0);
    jest.spyOn(repo, 'insertLaunches').mockResolvedValue(0);
    jest.spyOn(repo, 'insertLaunchTrades').mockResolvedValue(0);
    jest.spyOn(repo, 'markGraduated').mockResolvedValue(0);
    jest.spyOn(repo, 'findLaunchMarkets').mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a process that starts reads the swaps itself, from 90 s before its window: what the one before it may have left to the launchpad stream', async () => {
    const read = await tick('dex', T0);
    // The window is [cursor - 20 s, now - 15 s]; the swaps are read from 90 s before its start.
    expect(read).toEqual(SWAP_TOPICS.map((topic0) => ({ topic0, start: iso(T0 - 75_000 - 20_000 - 90_000), end: iso(T0 - 15_000) })));
    // The pool creations keep the window as it is.
    expect(calls.filter((c) => c.topic0 === DEX_TOPICS.v2PairCreated)).toEqual([
      { topic0: DEX_TOPICS.v2PairCreated, start: iso(T0 - 95_000), end: iso(T0 - 15_000) },
    ]);
  });

  it('the launchpad stream stores the swaps it reads as DEX swaps too, whether or not a launch trades on their pool', async () => {
    swaps = [swapAt(T0 - 30_000, 1), swapAt(T0 - 20_000, 2)];
    const read = await tick('launchpad', T0);

    expect(read).toHaveLength(2);
    expect(stored()).toEqual(swaps.map((s) => s.tx_hash));
    // They are not rows of the launchpad stream: no launch trades on that pair here.
    expect(advance).toHaveBeenCalledWith('launchpad', expect.objectContaining({ addRows: 0 }));
    expect(svc.swapsFed).toEqual({ from: T0 - 65_000, to: T0 - 15_000 });
  });

  it('the DEX stream then reads no swap: only its two creation topics, and counts the swaps stored for it', async () => {
    await tick('dex', T0); // its first window, read whole
    swaps = [swapAt(T0 + 10_000, 1)];
    await tick('launchpad', T0 + 10_000);
    await tick('launchpad', T0 + 40_000);
    advance.mockClear();

    const read = await tick('dex', T0 + 60_000);

    expect(read).toEqual([]);
    expect(calls.map((c) => c.topic0)).toEqual([DEX_TOPICS.v2PairCreated, DEX_TOPICS.v3PoolCreated]);
    expect(stored()).toEqual([swaps[0].tx_hash]);
    expect(advance).toHaveBeenCalledWith('dex', expect.objectContaining({ cursor: new Date(T0 + 45_000), addRows: 1 }));
  });

  it('a launchpad stream that stops: the DEX stream reads the swaps again, from where that stream stopped', async () => {
    await tick('dex', T0);
    await tick('launchpad', T0 + 10_000); // stands at T0 - 5 s, and stops there
    expect(await tick('dex', T0 + 60_000)).toEqual([]); // 50 s behind the window's end: still left to it
    // A swap in what the DEX stream left to it and it never read.
    swaps = [swapAt(T0 + 20_000, 7)];

    const read = await tick('dex', T0 + 120_000); // 110 s behind now

    // From a re-read margin (20 s) before where the launchpad stream stood, not from this window's own start.
    expect(read).toEqual(SWAP_TOPICS.map((topic0) => ({ topic0, start: iso(T0 - 5_000 - 20_000), end: iso(T0 + 105_000) })));
    expect(stored()).toEqual([swaps[0].tx_hash]);
    // ...and goes on reading them, from its own cursor, for as long as the other is behind.
    expect(await tick('dex', T0 + 180_000)).toEqual(SWAP_TOPICS.map((topic0) => ({ topic0, start: iso(T0 + 85_000), end: iso(T0 + 165_000) })));
  });

  it('...and leaves them to it again once it has caught up without a hole', async () => {
    await tick('dex', T0);
    await tick('launchpad', T0 + 10_000);
    await tick('dex', T0 + 60_000);
    await tick('dex', T0 + 120_000); // reads them itself
    // The launchpad stream comes back: one window from its cursor to now.
    const back = await tick('launchpad', T0 + 170_000);
    expect(back[0]).toMatchObject({ start: iso(T0 - 5_000 - 20_000), end: iso(T0 + 155_000) });

    expect(await tick('dex', T0 + 180_000)).toEqual([]);
  });

  it('a launchpad window cut at the page cap is not one the DEX stream relies on', async () => {
    await tick('dex', T0);
    await tick('launchpad', T0 + 10_000);
    expect(await tick('dex', T0 + 60_000)).toEqual([]);
    // The V2 swaps of the next launchpad window never end: 200 full pages, at the smallest step.
    svc.launchpadStepMs = 60_000;
    fetchPage.mockImplementation(async (_path, query) => {
      const q = query as unknown as { topic0: string; start_time: string; end_time: string };
      calls.push({ topic0: q.topic0, start: q.start_time, end: q.end_time });
      return q.topic0 === DEX_TOPICS.v2Swap ? { rows: [swapAt(T0, 1)], hasMore: true } : { rows: [], hasMore: false };
    });
    await tick('launchpad', T0 + 40_000);
    expect(svc.swapsFed).toBeNull();
    fetchPage.mockImplementation(async (_path, query) => {
      const q = query as unknown as { topic0: string; start_time: string; end_time: string };
      calls.push({ topic0: q.topic0, start: q.start_time, end: q.end_time });
      return { rows: [], hasMore: false };
    });

    const read = await tick('dex', T0 + 120_000);

    // From before the window that was cut (it started 20 s before T0 - 5 s).
    expect(read).toEqual(SWAP_TOPICS.map((topic0) => ({ topic0, start: iso(T0 - 25_000), end: iso(T0 + 105_000) })));
  });

  it('a swaps table that refuses a page does not hold the launchpad stream: its window goes through, and the DEX stream reads those swaps itself', async () => {
    await tick('dex', T0);
    await tick('launchpad', T0 + 10_000);
    expect(await tick('dex', T0 + 60_000)).toEqual([]);
    swaps = [swapAt(T0 + 20_000, 3)];
    insertSwaps.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    advance.mockClear();

    await expect(tick('launchpad', T0 + 70_000)).resolves.toHaveLength(2);

    // The launchpad stream moved on (its own rows are stored), and no longer vouches for the swaps.
    expect(advance).toHaveBeenCalledWith('launchpad', expect.objectContaining({ cursor: new Date(T0 + 55_000) }));
    expect(svc.swapsFed).toBeNull();
    const read = await tick('dex', T0 + 120_000);
    expect(read).toEqual(SWAP_TOPICS.map((topic0) => ({ topic0, start: iso(T0 - 25_000), end: iso(T0 + 105_000) })));
    expect(stored()).toContain(swaps[0].tx_hash);
  });

  it('a launchpad window that fails part-way is not one the DEX stream relies on, and is read again from the same cursor', async () => {
    await tick('dex', T0);
    await tick('launchpad', T0 + 10_000);
    const before = { ...(svc.swapsFed as { from: number; to: number }) };
    jest.spyOn(repo, 'insertLaunchTrades').mockRejectedValueOnce(new Error('connection lost'));
    swaps = [swapAt(T0 + 20_000, 4)];
    // A trade topic after the swaps fails: the swaps of the window were stored, the window was not completed.
    fetchPage.mockImplementation(async (_path, query) => {
      const q = query as unknown as { topic0: string; start_time: string; end_time: string };
      calls.push({ topic0: q.topic0, start: q.start_time, end: q.end_time });
      if (q.topic0 === LAUNCHPAD_TOPICS.v4Swap) throw new Error('API error: 503');
      const rows = q.topic0 === DEX_TOPICS.v2Swap ? swaps.filter((s) => String(s.block_time) >= q.start_time && String(s.block_time) <= q.end_time) : [];
      return { rows, hasMore: false };
    });

    await expect(tick('launchpad', T0 + 40_000)).rejects.toThrow('503');

    expect(svc.swapsFed).toEqual(before);
    expect(states.launchpad.cursor).toEqual(new Date(T0 - 5_000));
    expect(stored()).toEqual([swaps[0].tx_hash]);
  });

  it('counts each swap the launchpad stream stored once in the DEX stream\'s rows, even when that stream takes the count during a write', async () => {
    await tick('dex', T0);
    swaps = [swapAt(T0 + 10_000, 1), swapAt(T0 + 12_000, 2)];
    await tick('launchpad', T0 + 30_000); // 2 stored, not yet counted
    swaps = [...swaps, swapAt(T0 + 40_000, 3)];
    const added: number[] = [];
    advance.mockImplementation(async (stream, patch) => {
      const s = states[stream];
      if (s && patch.cursor) s.cursor = patch.cursor;
      if (stream === 'dex') added.push((patch as { addRows?: number }).addRows ?? 0);
    });
    // While the launchpad stream writes its next page of swaps, the DEX stream runs and takes the count.
    let during: Promise<unknown> | null = null;
    insertSwaps.mockImplementation(async (rows: unknown[]) => {
      if (!during) {
        during = svc.dexTick();
        await during;
      }
      return rows.length;
    });
    clock = T0 + 60_000;
    await svc.launchpadTick();
    insertSwaps.mockImplementation(async (rows: unknown[]) => rows.length);
    await tick('dex', T0 + 120_000);

    // 2, then the 3 of the page being written when the count was taken: never the first 2 again.
    expect(added.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('a launchpad stream replaying its history stores no DEX swap, and the DEX stream reads its own', async () => {
    states.launchpad = { cursor: new Date(T0 - 3 * 86_400_000), backfillDone: false };
    swaps = [swapAt(T0 - 3 * 86_400_000 + 60_000, 1)];
    await tick('dex', T0);
    insertSwaps.mockClear();

    await tick('launchpad', T0 + 10_000);

    expect(insertSwaps).not.toHaveBeenCalled();
    expect(svc.swapsFed).toBeNull();
    expect(await tick('dex', T0 + 60_000)).toHaveLength(2);
  });

  it('the launchpad stream reads its other topics as before', async () => {
    await tick('launchpad', T0);
    expect(new Set(calls.map((c) => c.topic0)).size).toBe(20);
    expect(calls.every((c) => c.start === iso(T0 - 65_000) && c.end === iso(T0 - 15_000))).toBe(true);
    expect(calls.map((c) => c.topic0)).toContain(LAUNCHPAD_TOPICS.v4Swap);
  });
});
