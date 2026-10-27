/**
 * Wallet list item mutations flush the caches that are actually read: the list
 * detail (walletlist:{id}), the owner's my-lists (walletlist:user:{id}, itemsCount)
 * and the public pages. They used to flush readlist:wallet:* patterns nothing writes,
 * so counts and details stayed stale for the 5 min TTL.
 */
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({
  prisma: { walletList: { findUnique: jest.fn() } },
}));
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: { invalidate: jest.fn(), invalidateByPattern: jest.fn(), getOrSet: jest.fn() },
}));
jest.mock('../../../src/services/xp/xp.service', () => ({
  xpService: { grantXp: jest.fn(), completeDailyTask: jest.fn() },
}));

import { WalletListItemService } from '../../../src/services/walletlist/walletlist-item.service';
import { cacheService } from '../../../src/core/cache.service';
import { prisma } from '../../../src/core/prisma.service';

const invalidate = cacheService.invalidate as jest.Mock;
const invalidateByPattern = cacheService.invalidateByPattern as jest.Mock;
const findList = (prisma as unknown as { walletList: { findUnique: jest.Mock } }).walletList.findUnique;

type Internals = {
  repository: { reorderItems: jest.Mock };
  walletListRepository: { hasAccess: jest.Mock };
};

function makeService() {
  const service = new WalletListItemService();
  const internals = service as unknown as Internals;
  internals.repository = { reorderItems: jest.fn().mockResolvedValue(undefined) };
  internals.walletListRepository = { hasAccess: jest.fn().mockResolvedValue(true) };
  return service;
}

describe('WalletListItemService cache invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidate.mockResolvedValue(undefined);
    invalidateByPattern.mockResolvedValue(undefined);
  });

  it('flushes the list detail, the owner my-lists and the public pages after a reorder', async () => {
    findList.mockResolvedValue({ userId: 7 });

    await makeService().reorderItems(3, [{ id: 1, order: 0 }], 7);

    expect(invalidate).toHaveBeenCalledWith('walletlist:3');
    expect(invalidate).toHaveBeenCalledWith('walletlist:user:7');
    expect(invalidateByPattern).toHaveBeenCalledWith('walletlist:public:*');
    expect(invalidateByPattern).toHaveBeenCalledWith('walletlist:list:*');
    expect(invalidateByPattern).toHaveBeenCalledWith('readlist:wallet:item:list:3:*');
  });

  it('flushes every my-lists key when the owner cannot be found', async () => {
    findList.mockResolvedValue(null);

    await makeService().reorderItems(3, [{ id: 1, order: 0 }], 7);

    expect(invalidateByPattern).toHaveBeenCalledWith('walletlist:user:*');
  });
});
