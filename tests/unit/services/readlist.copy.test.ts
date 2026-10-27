/**
 * Copying a public read list inserts the items with scalar ids (createMany on the Core DB);
 * items whose resource has disappeared (resource: null) are skipped instead of crashing.
 */
const mockCreateMany = jest.fn();

jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({
  prisma: { readListItem: { createMany: mockCreateMany } },
}));
jest.mock('../../../src/core/cache.service', () => ({ cacheService: {} }));
jest.mock('../../../src/repositories', () => ({ readListRepository: {} }));
jest.mock('../../../src/services/xp/xp.service', () => ({
  xpService: { grantXp: jest.fn().mockResolvedValue(undefined) },
}));

import { ReadListService } from '../../../src/services/readlist/readlist.service';

describe('ReadListService.copyReadList', () => {
  const original = {
    id: 1,
    name: 'Reading',
    description: null,
    isPublic: true,
    creator: { id: 1, name: 'owner' },
    items: [
      { id: 11, resourceId: 500, resource: { id: 500 }, notes: 'a', order: 0 },
      { id: 12, resourceId: 501, resource: null, notes: null, order: 1 }, // orphan
      { id: 13, resourceId: 194, resource: { id: 194 }, notes: null, order: null },
    ],
  };

  it('copies the items with scalar ids and skips orphans', async () => {
    const findById = jest
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ id: 2, items: [] });
    const stub = {
      repository: { findById },
      create: jest.fn().mockResolvedValue({ id: 2 }),
      firstFreeCopyName: jest.fn().mockResolvedValue('Reading (Copy)'),
    };

    const result = await ReadListService.prototype.copyReadList.call(stub, 1, 99);

    expect(result).toEqual({ id: 2, items: [] });
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany).toHaveBeenCalledWith({
      data: [
        { readListId: 2, resourceId: 500, notes: 'a', order: 0 },
        { readListId: 2, resourceId: 194, notes: null, order: 1 },
      ],
      skipDuplicates: true,
    });
  });
});
