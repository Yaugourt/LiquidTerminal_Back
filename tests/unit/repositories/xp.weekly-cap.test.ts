/**
 * The weekly cap count + insert run in one SQL transaction behind a per-(user, action)
 * advisory lock, so concurrent grants cannot all read a count under the cap.
 */
const calls: string[] = [];
const tx = {
  $executeRaw: jest.fn(async () => { calls.push('lock'); return 1; }),
  xpTransaction: {
    count: jest.fn(async () => { calls.push('count'); return 0; }),
    create: jest.fn(async () => { calls.push('create'); return { id: 1 }; }),
  },
};
jest.mock('../../../src/core/prisma.service', () => ({
  prisma: { $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) },
}));

import { XpRepository } from '../../../src/repositories/xp.repository';

const data = { userId: 7, actionType: 'ADD_EDUCATIONAL_RESOURCE' as const, xpAmount: 5, referenceId: 'a' };

beforeEach(() => { calls.length = 0; jest.clearAllMocks(); });

it('takes the advisory lock before counting, then inserts', async () => {
  const res = await new XpRepository().createTransactionWithinWeeklyCap(data, 10, new Date());
  expect(res).toEqual({ id: 1 });
  expect(calls).toEqual(['lock', 'count', 'create']);
});

it('writes nothing and returns null when the cap is reached', async () => {
  tx.xpTransaction.count.mockResolvedValueOnce(10);
  const res = await new XpRepository().createTransactionWithinWeeklyCap(data, 10, new Date());
  expect(res).toBeNull();
  expect(tx.xpTransaction.create).not.toHaveBeenCalled();
});
