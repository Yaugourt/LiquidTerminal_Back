import { ClientBudget } from '../../../src/utils/clientBudget';

describe('ClientBudget', () => {
  it('gives each client its own budget per window', () => {
    const budget = new ClientBudget(10, 1_000);
    expect(budget.take('a', 6, 5_000)).toBe(true);
    expect(budget.remaining('a', 5_100)).toBe(4);
    // Refused whole: nothing is taken by a request that does not fit.
    expect(budget.take('a', 5, 5_200)).toBe(false);
    expect(budget.remaining('a', 5_200)).toBe(4);
    expect(budget.take('a', 4, 5_300)).toBe(true);
    expect(budget.take('a', 1, 5_999)).toBe(false);
    // Another client is untouched.
    expect(budget.take('b', 10, 5_999)).toBe(true);
    // Next window: full again.
    expect(budget.remaining('a', 6_000)).toBe(10);
    expect(budget.take('a', 10, 6_000)).toBe(true);
  });

  it('never grants more than a whole window at once', () => {
    const budget = new ClientBudget(10, 1_000);
    expect(budget.take('a', 11, 0)).toBe(false);
    expect(budget.size).toBe(0);
  });

  it('tells how long until the window rolls over, at least a second', () => {
    const budget = new ClientBudget(10, 10_000);
    expect(budget.retryAfterS(20_000)).toBe(10);
    expect(budget.retryAfterS(27_500)).toBe(3);
    expect(budget.retryAfterS(29_999)).toBe(1);
  });

  it('never drops a client that is spending its budget to make room', () => {
    const budget = new ClientBudget(10, 1_000, 3);
    budget.take('heavy', 9, 0);
    budget.take('b', 1, 0);
    budget.take('c', 1, 0);
    // 'heavy' takes again: it is now the most recent, although it came first.
    budget.take('heavy', 1, 1);
    budget.take('d', 1, 2);
    budget.take('e', 1, 3);
    expect(budget.size).toBe(3);
    // Its spent budget was not forgotten.
    expect(budget.remaining('heavy', 4)).toBe(0);
    expect(budget.take('heavy', 1, 4)).toBe(false);
  });

  it('keeps at most maxClients entries, dropping the oldest', () => {
    const budget = new ClientBudget(10, 1_000, 3);
    budget.take('a', 10, 0);
    budget.take('b', 10, 0);
    budget.take('c', 10, 0);
    budget.take('d', 10, 0);
    expect(budget.size).toBe(3);
    // 'a' left: it starts over. 'b' is still spent.
    expect(budget.remaining('b', 1)).toBe(0);
    expect(budget.remaining('a', 1)).toBe(10);
  });
});
