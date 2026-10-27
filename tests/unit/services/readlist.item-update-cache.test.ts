/**
 * PUT /readlists/items/:itemId (notes / isRead) must flush the cached list detail
 * (readlist:{id}, which embeds items[]), the owner's lists and the public pages, not
 * only the item caches: viewers kept the old notes for the 5 min TTL.
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
jest.mock('../../../src/repositories', () => ({
  readListItemRepository: { findById: jest.fn(), update: jest.fn() },
  readListRepository: { isOwner: jest.fn() },
  educationalResourceRepository: {},
}));
jest.mock('../../../src/services/xp/xp.service', () => ({ xpService: {} }));

import { ReadListItemService } from '../../../src/services/readlist/readlist-item.service';
import { cacheService } from '../../../src/core/cache.service';
import { readListRepository } from '../../../src/repositories';

const invalidate = cacheService.invalidate as jest.Mock;
const invalidateByPattern = cacheService.invalidateByPattern as jest.Mock;
const isOwner = (readListRepository as unknown as { isOwner: jest.Mock }).isOwner;

describe('ReadListItemService.updateWithPermission cache', () => {
  it('flushes the list detail, the owner lists and the public pages', async () => {
    const service = new ReadListItemService();
    const update = jest.spyOn(service, 'update').mockResolvedValue({ id: 9 } as never);
    (service as unknown as { repository: { findById: jest.Mock } }).repository = {
      findById: jest.fn().mockResolvedValue({ id: 9, readListId: 4 }),
    };
    isOwner.mockResolvedValue(true);

    await service.updateWithPermission(9, 7, { notes: 'x' });

    expect(update).toHaveBeenCalledWith(9, { notes: 'x' });
    expect(invalidate).toHaveBeenCalledWith('readlist:4');
    expect(invalidate).toHaveBeenCalledWith('readlist:user:7');
    expect(invalidateByPattern).toHaveBeenCalledWith('readlist:public:*');
  });
});
