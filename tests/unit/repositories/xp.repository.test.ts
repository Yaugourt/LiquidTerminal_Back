/**
 * Weekly challenges: the first call of a week may run twice at once (GET /xp/weekly-challenges
 * next to a grant); creation must tolerate the duplicate, and progress is an SQL increment.
 */
const mockWeekly = {
  findMany: jest.fn(),
  createMany: jest.fn(),
  findUnique: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};

jest.mock('../../../src/core/prisma.service', () => ({ prisma: { weeklyChallenge: mockWeekly } }));

import { XpRepository } from '../../../src/repositories/xp.repository';

const repo = new XpRepository();

beforeEach(() => jest.resetAllMocks());

describe('getOrCreateWeeklyChallenges', () => {
  it('creates the four challenges with skipDuplicates and returns what is stored', async () => {
    const stored = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    mockWeekly.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(stored);
    mockWeekly.createMany.mockResolvedValue({ count: 0 }); // the other caller won every row

    const result = await repo.getOrCreateWeeklyChallenges(7, new Date('2026-10-27T10:00:00Z'));

    expect(result).toBe(stored);
    expect(mockWeekly.createMany).toHaveBeenCalledTimes(1);
    const arg = mockWeekly.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(4);
  });

  it('returns the existing challenges without creating anything', async () => {
    mockWeekly.findMany.mockResolvedValue([{ id: 1 }]);
    await repo.getOrCreateWeeklyChallenges(7, new Date());
    expect(mockWeekly.createMany).not.toHaveBeenCalled();
  });
});

describe('incrementChallengeProgress', () => {
  const base = { id: 5, target: 7, completed: false };

  it('adds to the stored progress in SQL instead of writing a value read earlier', async () => {
    mockWeekly.findUnique.mockResolvedValue({ ...base, progress: 2 });
    mockWeekly.update.mockResolvedValue({ ...base, progress: 3 });

    const result = await repo.incrementChallengeProgress(7, 'LOGIN_7_DAYS', new Date());

    expect(mockWeekly.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { progress: { increment: 1 } } });
    expect(result).toEqual({ ...base, progress: 3 });
    expect(mockWeekly.updateMany).not.toHaveBeenCalled();
  });

  it('completes once when the increment reaches the target', async () => {
    mockWeekly.findUnique
      .mockResolvedValueOnce({ ...base, progress: 6 })
      .mockResolvedValueOnce({ ...base, progress: 7, completed: true });
    mockWeekly.update.mockResolvedValue({ ...base, progress: 7 });
    mockWeekly.updateMany.mockResolvedValue({ count: 1 });

    const result = await repo.incrementChallengeProgress(7, 'LOGIN_7_DAYS', new Date());

    expect(mockWeekly.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5, completed: false } }),
    );
    expect(result?.completed).toBe(true);
  });
});
