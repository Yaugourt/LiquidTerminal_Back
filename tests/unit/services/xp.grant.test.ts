/**
 * grantXp: the user's total is an atomic increment (the level is recomputed from the
 * stored result), a reference that was already granted never spends a daily-cap slot,
 * and the leaderboard / history never pass a negative or NaN page/limit to the query.
 */
import { Prisma } from '@prisma/client';

const mockRepo = {
  hasDailyAction: jest.fn(),
  transactionExists: jest.fn(),
  countTransactions: jest.fn(),
  tryIncrementDailyActionCount: jest.fn(),
  releaseDailyActionCount: jest.fn(),
  createTransaction: jest.fn(),
  createTransactionWithinWeeklyCap: jest.fn(),
  incrementUserXp: jest.fn(),
  setUserLevel: jest.fn(),
  getOrCreateWeeklyChallenges: jest.fn(),
  incrementChallengeProgress: jest.fn(),
  getLeaderboard: jest.fn(),
  countUsersWithXp: jest.fn(),
  getUserRank: jest.fn(),
  getTransactionHistory: jest.fn(),
};

jest.mock('../../../src/repositories/xp.repository', () => ({ xpRepository: mockRepo }));
jest.mock('../../../src/repositories/user.repository', () => ({ userRepository: { findById: jest.fn() } }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { xpService } from '../../../src/services/xp/xp.service';
import { XpDailyCapExceededError } from '../../../src/errors/xp.errors';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });

beforeEach(() => {
  jest.resetAllMocks();
  mockRepo.transactionExists.mockResolvedValue(false);
  mockRepo.countTransactions.mockResolvedValue(0);
  mockRepo.tryIncrementDailyActionCount.mockResolvedValue({});
  mockRepo.releaseDailyActionCount.mockResolvedValue(undefined);
  mockRepo.createTransaction.mockResolvedValue({});
  mockRepo.setUserLevel.mockResolvedValue(undefined);
  mockRepo.getLeaderboard.mockResolvedValue([]);
  mockRepo.countUsersWithXp.mockResolvedValue(0);
  mockRepo.getTransactionHistory.mockResolvedValue([]);
});

describe('grantXp total', () => {
  it('increments the stored total and derives the level from the returned total', async () => {
    // A concurrent grant already moved the stored total to 190; ours (+15) makes it 205
    mockRepo.incrementUserXp.mockResolvedValue({ totalXp: 205, level: 1 });

    const granted = await xpService.grantXp({ userId: 1, actionType: 'REGISTRATION', referenceId: 'registration' });

    expect(granted).toBeGreaterThan(0);
    expect(mockRepo.incrementUserXp).toHaveBeenCalledWith(1, granted);
    // level 2 starts at 100 XP: the stored level (1) is brought in line with the stored total
    expect(mockRepo.setUserLevel).toHaveBeenCalledWith(1, 2, 205);
  });

  it('does not touch the level when it already matches the stored total', async () => {
    mockRepo.incrementUserXp.mockResolvedValue({ totalXp: 5, level: 1 });
    await xpService.grantXp({ userId: 1, actionType: 'REGISTRATION', referenceId: 'registration' });
    expect(mockRepo.setUserLevel).not.toHaveBeenCalled();
  });

  it('grants nothing and adds nothing when the registration reference already exists', async () => {
    mockRepo.createTransaction.mockRejectedValue(p2002());

    const granted = await xpService.grantXp({ userId: 1, actionType: 'REGISTRATION', referenceId: 'registration' });

    expect(granted).toBe(0);
    expect(mockRepo.incrementUserXp).not.toHaveBeenCalled();
  });
});

describe('daily cap slot', () => {
  it('does not spend a slot for a reference that was already granted', async () => {
    mockRepo.transactionExists.mockResolvedValue(true);

    const granted = await xpService.grantXp({ userId: 1, actionType: 'MARK_RESOURCE_READ', referenceId: 'readitem-7' });

    expect(granted).toBe(0);
    expect(mockRepo.tryIncrementDailyActionCount).not.toHaveBeenCalled();
    expect(mockRepo.createTransaction).not.toHaveBeenCalled();
  });

  it('gives the slot back when a concurrent grant of the same reference wins the insert', async () => {
    mockRepo.createTransaction.mockRejectedValue(p2002());

    const granted = await xpService.grantXp({ userId: 1, actionType: 'MARK_RESOURCE_READ', referenceId: 'readitem-7' });

    expect(granted).toBe(0);
    expect(mockRepo.tryIncrementDailyActionCount).toHaveBeenCalledTimes(1);
    expect(mockRepo.releaseDailyActionCount).toHaveBeenCalledTimes(1);
  });

  it('keeps the slot of a grant that went through', async () => {
    mockRepo.incrementUserXp.mockResolvedValue({ totalXp: 10, level: 1 });

    await xpService.grantXp({ userId: 1, actionType: 'MARK_RESOURCE_READ', referenceId: 'readitem-8' });

    expect(mockRepo.releaseDailyActionCount).not.toHaveBeenCalled();
  });

  it('still refuses past the cap without inserting', async () => {
    mockRepo.tryIncrementDailyActionCount.mockRejectedValue(new XpDailyCapExceededError());

    const granted = await xpService.grantXp({ userId: 1, actionType: 'MARK_RESOURCE_READ', referenceId: 'readitem-9' });

    expect(granted).toBe(0);
    expect(mockRepo.createTransaction).not.toHaveBeenCalled();
    expect(mockRepo.releaseDailyActionCount).not.toHaveBeenCalled();
  });
});

describe('paging bounds', () => {
  it.each([
    [{ limit: -3 }, { skip: 0, take: 20 }],
    [{ limit: NaN, page: NaN }, { skip: 0, take: 20 }],
    [{ page: -1, limit: 20 }, { skip: 0, take: 20 }],
    [{ page: 0, limit: 0 }, { skip: 0, take: 20 }],
    [{ page: 2, limit: 500 }, { skip: 100, take: 100 }],
    [{ page: 3, limit: 10 }, { skip: 20, take: 10 }],
  ])('leaderboard %j queries %j', async (options, expected) => {
    await xpService.getLeaderboard(options);
    expect(mockRepo.getLeaderboard).toHaveBeenCalledWith(expected);
  });

  it('keeps ranks starting at 1 for a negative limit', async () => {
    mockRepo.getLeaderboard.mockResolvedValue([{ name: 'a', totalXp: 900, level: 7 }]);
    const res = await xpService.getLeaderboard({ limit: -3 });
    expect(res.leaderboard[0].rank).toBe(1);
  });

  it('history clamps the same way', async () => {
    await xpService.getTransactionHistory(1, { page: -4, limit: -1 });
    expect(mockRepo.getTransactionHistory).toHaveBeenCalledWith(1, { skip: 0, take: 20, actionType: undefined });
  });
});

describe('weekly cap', () => {
  it('grants nothing and releases the daily slot when the atomic insert finds the cap reached', async () => {
    // The read-only pre-check passed (count 0) but concurrent grants filled the cap before the insert
    mockRepo.createTransactionWithinWeeklyCap.mockResolvedValue(null);

    const granted = await xpService.grantXp({ userId: 1, actionType: 'ADD_EDUCATIONAL_RESOURCE', referenceId: 'r1' });

    expect(granted).toBe(0);
    expect(mockRepo.createTransactionWithinWeeklyCap).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, actionType: 'ADD_EDUCATIONAL_RESOURCE' }),
      10,
      expect.any(Date),
    );
    expect(mockRepo.createTransaction).not.toHaveBeenCalled();
    expect(mockRepo.incrementUserXp).not.toHaveBeenCalled();
  });

  it('grants the XP when the atomic insert succeeds', async () => {
    mockRepo.createTransactionWithinWeeklyCap.mockResolvedValue({});
    mockRepo.incrementUserXp.mockResolvedValue({ totalXp: 50, level: 1 });
    const granted = await xpService.grantXp({ userId: 1, actionType: 'ADD_EDUCATIONAL_RESOURCE', referenceId: 'r2' });
    expect(granted).toBeGreaterThan(0);
  });
});
