import { runWithTx, scopedClient } from '../../../src/utils/tx-scope';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Repo {}

describe('tx-scope', () => {
  it('binds the listed repository inside fn, across awaits, and not after it resolves', async () => {
    const repo = new Repo();
    const tx = { name: 'tx' };

    expect(scopedClient(repo)).toBeUndefined();
    const seen = await runWithTx(tx, [repo], async () => {
      await sleep(1);
      await Promise.resolve();
      return scopedClient(repo);
    });

    expect(seen).toBe(tx);
    expect(scopedClient(repo)).toBeUndefined();
  });

  it('is gone after fn throws', async () => {
    const repo = new Repo();
    let insideBeforeThrow: unknown;

    await expect(
      runWithTx({ name: 'tx' }, [repo], async () => {
        insideBeforeThrow = scopedClient(repo);
        await sleep(1);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(insideBeforeThrow).toEqual({ name: 'tx' });
    expect(scopedClient(repo)).toBeUndefined();
  });

  it('does not bind a repository that is not listed', async () => {
    const listed = new Repo();
    const other = new Repo();

    await runWithTx({ name: 'tx' }, [listed], async () => {
      expect(scopedClient(listed)).toEqual({ name: 'tx' });
      expect(scopedClient(other)).toBeUndefined();
    });
  });

  it('binds per instance, not per class', async () => {
    const a = new Repo();
    const b = new Repo();

    await runWithTx({ name: 'tx' }, [a], async () => {
      expect(scopedClient(a)).toBeDefined();
      expect(scopedClient(b)).toBeUndefined();
    });
  });

  it('nested scopes inherit the outer bindings and override those they list again', async () => {
    const a = new Repo();
    const b = new Repo();
    const outer = { name: 'outer' };
    const inner = { name: 'inner' };

    await runWithTx(outer, [a, b], async () => {
      await runWithTx(inner, [a], async () => {
        expect(scopedClient(a)).toBe(inner);
        expect(scopedClient(b)).toBe(outer);
      });
      // the inner scope ended: the outer binding is back
      expect(scopedClient(a)).toBe(outer);
      expect(scopedClient(b)).toBe(outer);
    });
  });

  it('an inner scope can bind a repository the outer one did not list', async () => {
    const a = new Repo();
    const b = new Repo();

    await runWithTx({ name: 'outer' }, [a], async () => {
      await runWithTx({ name: 'inner' }, [b], async () => {
        expect(scopedClient(a)).toEqual({ name: 'outer' });
        expect(scopedClient(b)).toEqual({ name: 'inner' });
      });
      expect(scopedClient(b)).toBeUndefined();
    });
  });

  it('two interleaved concurrent scopes each see only their own client', async () => {
    const repo = new Repo();
    const txA = { name: 'A' };
    const txB = { name: 'B' };
    const log: string[] = [];

    const run = (tx: { name: string }, delays: number[]) =>
      runWithTx(tx, [repo], async () => {
        for (const delay of delays) {
          await sleep(delay);
          log.push(`${tx.name}:${(scopedClient(repo) as { name: string }).name}`);
        }
      });

    // A reads at 5 and 20 ms, B at 10 and 15 ms: A B B A
    await Promise.all([run(txA, [5, 15]), run(txB, [10, 5])]);

    expect(log.filter((l) => l.startsWith('A'))).toEqual(['A:A', 'A:A']);
    expect(log.filter((l) => l.startsWith('B'))).toEqual(['B:B', 'B:B']);
    // really interleaved: B's first read happens between A's two
    expect(log.indexOf('B:B')).toBeGreaterThan(log.indexOf('A:A'));
    expect(log.indexOf('B:B')).toBeLessThan(log.lastIndexOf('A:A'));
    expect(scopedClient(repo)).toBeUndefined();
  });

  it('a read made by another flow while a scope is open does not see its client', async () => {
    const repo = new Repo();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));

    const scoped = runWithTx({ name: 'tx' }, [repo], async () => {
      entered();
      await gate;
    });
    await inside;

    expect(scopedClient(repo)).toBeUndefined();
    release();
    await scoped;
  });
});
