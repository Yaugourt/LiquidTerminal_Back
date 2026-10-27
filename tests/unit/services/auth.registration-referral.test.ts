/**
 * First login: the registration bonus carries a fixed reference (so a repeated login
 * hits the unique index instead of granting again), and a referral is counted once even
 * when two first logins race.
 */
const mockGrantXp = jest.fn();
const mockFindOrCreate = jest.fn();
const mockAssignReferrer = jest.fn();
const mockFindFirst = jest.fn();
const mockUpdateMany = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/xp/xp.service', () => ({ xpService: { grantXp: mockGrantXp } }));
jest.mock('../../../src/repositories/user.repository', () => ({ userRepository: { findOrCreate: mockFindOrCreate } }));
jest.mock('../../../src/core/prisma.service', () => {
  const tx = { user: { updateMany: mockUpdateMany, update: mockUpdate } };
  return {
    prisma: {
      user: { findFirst: mockFindFirst },
      $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
  };
});

import { AuthService } from '../../../src/services/auth/auth.service';
import { ReferralService } from '../../../src/services/auth/referral.service';

beforeEach(() => jest.resetAllMocks());

describe('registration XP', () => {
  it('is granted under a fixed referenceId', async () => {
    mockFindOrCreate.mockResolvedValue({ id: 4, createdAt: new Date() });
    mockGrantXp.mockResolvedValue(100);

    await AuthService.getInstance().findOrCreateUser({ sub: 'did:privy:a' } as never, 'alice');

    expect(mockGrantXp).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 4, actionType: 'REGISTRATION', referenceId: 'registration' }),
    );
  });
});

describe('assignReferrer', () => {
  beforeEach(() => {
    mockFindFirst.mockResolvedValue({ id: 1, name: 'Referrer' });
    mockGrantXp.mockResolvedValue(0);
  });

  it('counts the referral and sets referredBy conditionally on it being empty', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await ReferralService.getInstance().assignReferrer(2, 'referrer');

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 2, referredBy: null },
      data: { referredBy: 'Referrer' },
    });
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 1 }, data: { referralCount: { increment: 1 } } });
  });

  it('does not count again when another login already assigned the referrer', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(ReferralService.getInstance().assignReferrer(2, 'referrer')).rejects.toThrow('already has a referrer');

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
