/**
 * Bulk wallet import into a non-empty list: the new WalletListItems continue after
 * the list's current max order instead of restarting at 0 (which interleaved them
 * with the existing items and duplicated order values).
 */
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: { invalidate: jest.fn(), invalidateByPattern: jest.fn() },
}));
jest.mock('../../../src/repositories/wallet.repository', () => ({
  walletRepository: {
    bulkCreate: jest.fn(),
    findManyByAddresses: jest.fn(),
  },
}));
jest.mock('../../../src/repositories/userWallet.repository', () => ({
  userWalletRepository: {
    bulkCreate: jest.fn(),
    findManyByUserAndWallets: jest.fn(),
  },
}));
const mockTx = {
  user: { findUnique: jest.fn() },
  walletList: { findUnique: jest.fn() },
  walletListItem: { findMany: jest.fn(), findFirst: jest.fn(), createMany: jest.fn() },
};
jest.mock('../../../src/core/transaction.service', () => ({
  transactionService: { execute: (op: (tx: unknown) => Promise<unknown>) => op(mockTx) },
}));

import { WalletService } from '../../../src/services/wallet/wallet.service';
import { walletRepository } from '../../../src/repositories/wallet.repository';
import { userWalletRepository } from '../../../src/repositories/userWallet.repository';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

describe('WalletService.bulkAddWallets list order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTx.user.findUnique.mockResolvedValue({ id: 1 });
    mockTx.walletList.findUnique.mockResolvedValue({ id: 5, userId: 1 });
    (walletRepository.findManyByAddresses as jest.Mock).mockResolvedValue([
      { id: 10, address: A },
      { id: 11, address: B },
    ]);
    (userWalletRepository.findManyByUserAndWallets as jest.Mock)
      .mockResolvedValueOnce([]) // before the insert
      .mockResolvedValue([{ id: 100, walletId: 10 }, { id: 101, walletId: 11 }]);
    mockTx.walletListItem.findMany.mockResolvedValue([]);
  });

  const orders = () => mockTx.walletListItem.createMany.mock.calls[0][0].data.map((d: { order: number }) => d.order);

  it('continues after the current max order of a non-empty list', async () => {
    mockTx.walletListItem.findFirst.mockResolvedValue({ order: 6 });

    await new WalletService().bulkAddWallets('privy-1', [{ address: A }, { address: B }], 5);

    expect(orders()).toEqual([7, 8]);
  });

  it('starts at 0 for an empty list', async () => {
    mockTx.walletListItem.findFirst.mockResolvedValue(null);

    await new WalletService().bulkAddWallets('privy-1', [{ address: A }, { address: B }], 5);

    expect(orders()).toEqual([0, 1]);
  });
});
