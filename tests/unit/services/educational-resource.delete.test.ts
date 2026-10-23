/**
 * Deleting a Content resource must also remove the Core ReadListItem rows that
 * reference it (cross-DB: no FK cascade), after the Content transaction commits,
 * without ever failing the request when the Core cleanup fails, and also when the
 * Content delete failed half-way with the resource already gone.
 */
const calls: string[] = [];

jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/prisma.content.service', () => ({
  prismaContent: {
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      calls.push('content-tx:start');
      const result = await cb({});
      calls.push('content-tx:commit');
      return result;
    }),
  },
}));
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateByPattern: jest.fn().mockResolvedValue(undefined),
    getOrSet: jest.fn(),
  },
}));
jest.mock('../../../src/repositories', () => ({
  educationalResourceRepository: {
    setPrismaClient: jest.fn(),
    resetPrismaClient: jest.fn(),
    findById: jest.fn(),
    delete: jest.fn(),
  },
  educationalCategoryRepository: {},
  readListItemRepository: { deleteByResourceId: jest.fn() },
}));
jest.mock('../../../src/services/xp/xp.service', () => ({ xpService: {} }));
jest.mock('../../../src/services/linkPreview/linkPreview.service', () => ({
  LinkPreviewService: { getInstance: jest.fn() },
}));

import { EducationalResourceService } from '../../../src/services/educational/educational-resource.service';
import { EducationalResourceNotFoundError } from '../../../src/errors/educational.errors';
import { educationalResourceRepository, readListItemRepository } from '../../../src/repositories';
import { cacheService } from '../../../src/core/cache.service';
import { LinkPreviewService } from '../../../src/services/linkPreview/linkPreview.service';

const resourceRepo = educationalResourceRepository as unknown as {
  findById: jest.Mock;
  delete: jest.Mock;
};
const itemRepo = readListItemRepository as unknown as { deleteByResourceId: jest.Mock };
const invalidateByPattern = cacheService.invalidateByPattern as jest.Mock;

describe('EducationalResourceService.delete', () => {
  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
    // mockReset also drops leftover mockResolvedValueOnce values, so no test leaks into the next
    resourceRepo.findById.mockReset();
    resourceRepo.delete.mockReset();
    (LinkPreviewService.getInstance as jest.Mock).mockReset();
    resourceRepo.findById.mockResolvedValue({ id: 7, linkPreviewId: null });
    resourceRepo.delete.mockImplementation(async () => {
      calls.push('content-delete');
    });
    itemRepo.deleteByResourceId.mockImplementation(async () => {
      calls.push('core-cleanup');
      return 2;
    });
  });

  it('removes the Core read list items after the Content transaction has committed', async () => {
    await new EducationalResourceService().delete(7);

    expect(itemRepo.deleteByResourceId).toHaveBeenCalledWith(7);
    expect(calls.indexOf('core-cleanup')).toBeGreaterThan(calls.lastIndexOf('content-tx:commit'));
    expect(calls.indexOf('core-cleanup')).toBeGreaterThan(calls.indexOf('content-delete'));
  });

  it('flushes the read list caches when items were removed', async () => {
    await new EducationalResourceService().delete(7);

    const patterns = invalidateByPattern.mock.calls.map(([p]) => p);
    expect(patterns).toEqual(expect.arrayContaining(['readlist:*', 'readlist_item:*']));
  });

  it('does not touch the read list caches when no item referenced the resource', async () => {
    itemRepo.deleteByResourceId.mockResolvedValue(0);

    await new EducationalResourceService().delete(7);

    const patterns = invalidateByPattern.mock.calls.map(([p]) => p);
    expect(patterns).not.toContain('readlist:*');
  });

  it('still resolves when the Core cleanup throws', async () => {
    itemRepo.deleteByResourceId.mockRejectedValue(new Error('core db down'));

    await expect(new EducationalResourceService().delete(7)).resolves.toBeUndefined();
    expect(resourceRepo.delete).toHaveBeenCalledWith(7);
  });

  it('still removes leftover items when the resource is already gone, and reports not found', async () => {
    resourceRepo.findById.mockResolvedValue(null);

    await expect(new EducationalResourceService().delete(7)).rejects.toBeInstanceOf(
      EducationalResourceNotFoundError
    );
    expect(resourceRepo.delete).not.toHaveBeenCalled();
    expect(itemRepo.deleteByResourceId).toHaveBeenCalledWith(7);
  });

  it('removes the items when the resource row is gone but the link preview step failed', async () => {
    // looked up by the service, then by BaseService.delete, then after the failure
    resourceRepo.findById
      .mockResolvedValueOnce({ id: 7, linkPreviewId: 'lp1' })
      .mockResolvedValueOnce({ id: 7, linkPreviewId: 'lp1' })
      .mockResolvedValueOnce(null);
    (LinkPreviewService.getInstance as jest.Mock).mockReturnValue({
      isUsedByOtherResources: jest.fn().mockRejectedValue(new Error('preview lookup failed')),
      deleteById: jest.fn(),
    });

    await expect(new EducationalResourceService().delete(7)).rejects.toThrow('preview lookup failed');
    expect(resourceRepo.delete).toHaveBeenCalledWith(7);
    expect(itemRepo.deleteByResourceId).toHaveBeenCalledWith(7);
  });

  it('keeps the items when the Content delete failed and the resource still exists', async () => {
    resourceRepo.delete.mockRejectedValue(new Error('content db down'));

    await expect(new EducationalResourceService().delete(7)).rejects.toThrow('content db down');
    expect(itemRepo.deleteByResourceId).not.toHaveBeenCalled();
  });

  it('keeps the items when Content cannot even be asked whether the resource is gone', async () => {
    resourceRepo.delete.mockRejectedValue(new Error('content db down'));
    resourceRepo.findById
      .mockResolvedValueOnce({ id: 7, linkPreviewId: null })
      .mockResolvedValueOnce({ id: 7, linkPreviewId: null })
      .mockRejectedValueOnce(new Error('content db down'));

    await expect(new EducationalResourceService().delete(7)).rejects.toThrow('content db down');
    expect(itemRepo.deleteByResourceId).not.toHaveBeenCalled();
  });
});
