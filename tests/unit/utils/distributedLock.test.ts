/**
 * Locks have an owner (2026-11-11). The value was the process id (1 in every container) and the
 * release an unconditional DEL: a run that outlived its TTL deleted the lock of the process that
 * had taken over. A lock is now given back by its owner only, and can be kept for as long as
 * the work runs.
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));

/** A Redis with what the locks use: SET NX EX, the two compare-and-act scripts, expiry by the clock. */
class FakeRedis {
  public store = new Map<string, { value: string; expiresAt: number }>();
  public failing = false;
  public evals: string[] = [];
  private get(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  public async set(key: string, value: string, _ex: string, ttl: number, _nx: string): Promise<'OK' | null> {
    if (this.failing) throw new Error('Connection is closed');
    if (this.get(key) !== null) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }
  public async eval(script: string, _keys: number, key: string, token: string, ttl?: string): Promise<number> {
    if (this.failing) throw new Error('Connection is closed');
    this.evals.push(script.includes("'del'") ? 'release' : 'renew');
    if (this.get(key) !== token) return 0;
    if (script.includes("'del'")) this.store.delete(key);
    else this.store.set(key, { value: token, expiresAt: Date.now() + Number(ttl) * 1000 });
    return 1;
  }
  public holder(key: string): string | null {
    return this.get(key);
  }
}
const mockRedis = new FakeRedis();
jest.mock('../../../src/core/redis.service', () => ({ redisService: { getClient: () => mockRedis } }));

import { withDistributedLock } from '../../../src/utils/distributedLock';

describe('withDistributedLock', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00Z') });
    mockRedis.store.clear();
    mockRedis.failing = false;
    mockRedis.evals = [];
  });
  afterEach(() => jest.useRealTimers());

  it('runs the work under a lock of its own, and gives it back', async () => {
    let during: string | null = null;
    const ran = await withDistributedLock('poll:x', 120, async () => {
      during = mockRedis.holder('poll:x');
    });
    expect(ran).toBe(true);
    expect(during).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockRedis.holder('poll:x')).toBeNull();
  });

  it('skips the work when someone else holds the lock', async () => {
    mockRedis.store.set('poll:x', { value: 'someone-else', expiresAt: Date.now() + 60_000 });
    const work = jest.fn(async () => undefined);
    expect(await withDistributedLock('poll:x', 120, work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(mockRedis.holder('poll:x')).toBe('someone-else');
  });

  it('gives the lock back when the work fails', async () => {
    await expect(withDistributedLock('poll:x', 120, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(mockRedis.holder('poll:x')).toBeNull();
  });

  it('never deletes the lock of the one that took over after its own expired', async () => {
    await withDistributedLock('poll:x', 120, async () => {
      // The work outlives the lock, and another process takes it.
      jest.setSystemTime(Date.now() + 130_000);
      expect(await mockRedis.set('poll:x', 'the-next-process', 'EX', 120, 'NX')).toBe('OK');
    });
    expect(mockRedis.holder('poll:x')).toBe('the-next-process');
  });

  it('with renew, keeps the lock for as long as the work runs, however long that is', async () => {
    let release: () => void = () => undefined;
    const working = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = withDistributedLock('poll:x', 120, () => working, { renew: true });
    // Ten minutes of work under a 2-minute lock.
    for (let i = 0; i < 15; i++) {
      await jest.advanceTimersByTimeAsync(40_000);
      expect(mockRedis.holder('poll:x')).not.toBeNull();
      expect(await mockRedis.set('poll:x', 'the-next-process', 'EX', 120, 'NX')).toBeNull();
    }
    release();
    await run;
    expect(mockRedis.holder('poll:x')).toBeNull();
    // No renewal once the work is over.
    const renewals = mockRedis.evals.filter((e) => e === 'renew').length;
    await jest.advanceTimersByTimeAsync(300_000);
    expect(mockRedis.evals.filter((e) => e === 'renew').length).toBe(renewals);
  });

  it('without renew, a lock is lost when its time is up (as before)', async () => {
    let release: () => void = () => undefined;
    const working = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = withDistributedLock('poll:x', 120, () => working);
    await jest.advanceTimersByTimeAsync(130_000);
    expect(mockRedis.holder('poll:x')).toBeNull();
    release();
    await run;
  });

  it('runs the work without a lock when Redis cannot be asked, and has nothing to give back', async () => {
    mockRedis.failing = true;
    const work = jest.fn(async () => undefined);
    expect(await withDistributedLock('poll:x', 120, work, { renew: true })).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    expect(mockRedis.evals).toEqual([]);
  });
});
