/**
 * A stream's loop starts again when its tick ends, and nothing bounded a tick: a write that
 * waited on a lock, or an answer whose body stopped half way, stopped the stream until the next
 * restart, with no error to see (2026-11-11). A tick is now given up after its stream's time
 * limit: the stream records it and runs again, and the tick given up stops at its next step.
 * The stream's lock is its own, and is kept for as long as the tick runs.
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
const mockRedis = {
  locks: new Map<string, string>(),
  renewals: 0,
  async set(key: string, value: string): Promise<'OK' | null> {
    if (this.locks.has(key)) return null;
    this.locks.set(key, value);
    return 'OK';
  },
  async eval(script: string, _n: number, key: string, token: string): Promise<number> {
    if (this.locks.get(key) !== token) return 0;
    if (script.includes("'del'")) this.locks.delete(key);
    else this.renewals += 1;
    return 1;
  },
};
jest.mock('../../../src/core/redis.service', () => ({ redisService: { getClient: () => mockRedis } }));

import { ElysiumIngestionService } from '../../../src/services/elysium/elysium-ingestion.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';

const MIN = 60_000;
type Internals = {
  stopped: boolean;
  runTick: (stream: string, tick: () => Promise<number>) => Promise<number>;
  ensureRunning: () => void;
};

describe('Elysium ingestion: a tick that does not come back', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  let recordError: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00Z') });
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    mockRedis.locks.clear();
    mockRedis.renewals = 0;
    recordError = jest.spyOn(repo, 'recordError').mockResolvedValue(undefined);
    jest.spyOn(repo, 'addRejects').mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('is given up after 5 minutes: the stream records it, gives its lock back, and runs again', async () => {
    const never = new Promise<number>(() => undefined);
    const run = svc.runTick('tx', () => never);
    let settled: number | undefined;
    void run.then((next) => {
      settled = next;
    });

    await jest.advanceTimersByTimeAsync(4 * MIN + 59_000);
    expect(settled).toBeUndefined();
    // Held all along, under a 2-minute lock.
    expect(mockRedis.locks.has('poll:elysium-ingest:tx')).toBe(true);
    expect(mockRedis.renewals).toBeGreaterThanOrEqual(6);

    await jest.advanceTimersByTimeAsync(2_000);
    // One failure: the usual wait of the stream, doubled.
    expect(settled).toBe(60_000);
    expect(recordError).toHaveBeenCalledWith('tx', 'Elysium ingest: tx tick given up after 300 s');
    expect(mockRedis.locks.has('poll:elysium-ingest:tx')).toBe(false);
  });

  it('the tick given up stops at its next step instead of going on beside the next one', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: string[] = [];
    const tick = async (): Promise<number> => {
      await gate; // a statement that waited ten minutes on a lock
      svc.ensureRunning();
      written.push('a window read by a tick nobody waits for');
      return 30_000;
    };
    const run = svc.runTick('tx', tick);
    await jest.advanceTimersByTimeAsync(5 * MIN + 1_000);
    await run;

    release();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(written).toEqual([]);
  });

  it('leaves a tick that ends in time alone, and its limit behind', async () => {
    const next = await svc.runTick('tx', async () => {
      svc.ensureRunning();
      return 30_000;
    });
    expect(next).toBe(30_000);
    expect(recordError).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives a registry run 20 minutes, and a day of rollups too', async () => {
    const never = new Promise<number>(() => undefined);
    for (const stream of ['tokens', 'rollup']) {
      let settled = false;
      void svc.runTick(stream, () => never).then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(19 * MIN);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(2 * MIN);
      expect(settled).toBe(true);
    }
    expect(recordError).toHaveBeenCalledWith('tokens', 'Elysium ingest: tokens tick given up after 1200 s');
  });

  it('does not start a stream another process holds', async () => {
    mockRedis.locks.set('poll:elysium-ingest:dex', 'another-process');
    const tick = jest.fn(async () => 1);
    expect(await svc.runTick('dex', tick)).toBe(60_000);
    expect(tick).not.toHaveBeenCalled();
    expect(mockRedis.locks.get('poll:elysium-ingest:dex')).toBe('another-process');
  });
});
