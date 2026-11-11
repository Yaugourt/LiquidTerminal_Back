import { FairGate, GateBusyError } from '../../../src/utils/fairGate';

/** A job the test finishes by hand. */
function job(): { run: () => Promise<string>; finish: (value?: string) => void; fail: (error: Error) => void; started: boolean } {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const handle = {
    started: false,
    run: () => {
      handle.started = true;
      return new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    finish: (value = 'done') => resolve(value),
    fail: (error: Error) => reject(error),
  };
  return handle;
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('FairGate', () => {
  it('runs at most `max` at once and `maxPerClient` for one client', async () => {
    const gate = new FairGate({ max: 3, maxPerClient: 2, maxWaiting: 10, maxWaitingPerClient: 5 });
    const a = [job(), job(), job()];
    const b = [job(), job()];
    const results = [...a.map((j) => gate.run('a', j.run)), ...b.map((j) => gate.run('b', j.run))];
    await turn();
    // a: two running, the third waits on a's own share. b: one running (the gate is full), one waiting.
    expect(a.map((j) => j.started)).toEqual([true, true, false]);
    expect(b.map((j) => j.started)).toEqual([true, false]);
    expect(gate.stats).toEqual({ running: 3, waiting: 2, clients: 2 });

    a[0].finish();
    await turn();
    // Both clients now run one: the slot goes to the one served longest ago, a.
    expect(a[2].started).toBe(true);
    expect(b[1].started).toBe(false);
    expect(gate.stats.running).toBe(3);
    a[1].finish();
    b[0].finish();
    await turn();
    expect(a[2].started && b[1].started).toBe(true);
    a[2].finish();
    b[1].finish();
    await expect(Promise.all(results)).resolves.toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(gate.stats).toEqual({ running: 0, waiting: 0, clients: 0 });
  });

  it('gives a free slot to the client that runs the least, not to the one that asked first', async () => {
    const gate = new FairGate({ max: 2, maxPerClient: 2, maxWaiting: 10, maxWaitingPerClient: 5 });
    const flood = [job(), job(), job(), job()];
    const other = job();
    const all = flood.map((j) => gate.run('flood', j.run));
    await turn();
    all.push(gate.run('other', other.run));
    await turn();
    expect(flood.map((j) => j.started)).toEqual([true, true, false, false]);
    expect(other.started).toBe(false);

    flood[0].finish();
    await turn();
    // 'flood' still runs one and had two older waiters; 'other' runs none and goes first.
    expect(other.started).toBe(true);
    expect(flood[2].started).toBe(false);

    for (const j of [flood[1], other]) j.finish();
    await turn();
    for (const j of [flood[2], flood[3]]) j.finish();
    await Promise.all(all);
  });

  it('refuses a client past its own waiting room without touching the others', async () => {
    const gate = new FairGate({ max: 1, maxPerClient: 1, maxWaiting: 10, maxWaitingPerClient: 2 });
    const first = job();
    const running = gate.run('a', first.run);
    const waiting = [gate.run('a', job().run), gate.run('a', job().run)];
    waiting.forEach((p) => p.catch(() => undefined));
    await expect(gate.run('a', job().run)).rejects.toMatchObject({ name: 'GateBusyError', ownShare: true, retryAfterS: 1 });
    // Another client can still wait.
    const other = job();
    const otherRun = gate.run('b', other.run);
    await turn();
    expect(gate.stats.waiting).toBe(3);
    first.finish();
    await running;
    await turn();
    // Neither runs anything now, and 'a' was just served: 'b' goes before a's two older waiters.
    expect(other.started).toBe(true);
    other.finish();
    await otherRun;
    expect(gate.stats.running).toBe(1);
  });

  it('refuses everyone once the whole waiting room is full', async () => {
    const gate = new FairGate({ max: 1, maxPerClient: 1, maxWaiting: 2, maxWaitingPerClient: 2 });
    void gate.run('a', job().run);
    void gate.run('b', job().run).catch(() => undefined);
    void gate.run('c', job().run).catch(() => undefined);
    await expect(gate.run('d', job().run)).rejects.toMatchObject({ ownShare: false });
  });

  it('replace-oldest: a newcomer takes the place of its client’s oldest waiter', async () => {
    const gate = new FairGate({ max: 1, maxPerClient: 1, maxWaiting: 10, maxWaitingPerClient: 1, whenClientQueueFull: 'replace-oldest' });
    const first = job();
    const second = job();
    const third = job();
    const running = gate.run('a', first.run);
    const replaced = gate.run('a', second.run);
    const latest = gate.run('a', third.run);
    await expect(replaced).rejects.toBeInstanceOf(GateBusyError);
    expect(second.started).toBe(false);
    first.finish();
    await running;
    await turn();
    expect(third.started).toBe(true);
    third.finish('latest');
    await expect(latest).resolves.toBe('latest');
  });

  it('frees the slot when the job throws', async () => {
    const gate = new FairGate({ max: 1, maxPerClient: 1, maxWaiting: 5, maxWaitingPerClient: 5 });
    const failing = job();
    const next = job();
    const failed = gate.run('a', failing.run);
    const after = gate.run('b', next.run);
    await turn();
    failing.fail(new Error('boom'));
    await expect(failed).rejects.toThrow('boom');
    await turn();
    expect(next.started).toBe(true);
    next.finish();
    await after;
    expect(gate.stats).toEqual({ running: 0, waiting: 0, clients: 0 });
  });

  it('refuses a caller that waited too long', async () => {
    jest.useFakeTimers();
    try {
      const gate = new FairGate({ max: 1, maxPerClient: 1, maxWaiting: 5, maxWaitingPerClient: 5, maxWaitMs: 1_000 });
      const first = job();
      const late = job();
      const running = gate.run('a', first.run);
      const waited = gate.run('b', late.run);
      const outcome = expect(waited).rejects.toBeInstanceOf(GateBusyError);
      jest.advanceTimersByTime(1_001);
      await outcome;
      expect(late.started).toBe(false);
      expect(gate.stats.waiting).toBe(0);
      first.finish();
      await running;
    } finally {
      jest.useRealTimers();
    }
  });
});
