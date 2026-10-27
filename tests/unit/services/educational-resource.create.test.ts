/**
 * Creating a resource: super.create opens and commits its own Content transaction;
 * the link preview fetch (up to ~20 s), the linkPreviewId update and the XP grant
 * run after it, outside any transaction. An outer transaction around them only held
 * a connection across the network call and failed its commit (P2028 expired,
 * Prisma's interactive timeout is 5 s) when the preview was slow, answering 500
 * for a resource that had been created.
 */
const calls: string[] = [];
const mockTransaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
  calls.push('tx:start');
  const result = await cb({});
  calls.push('tx:commit');
  return result;
});

jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/prisma.content.service', () => ({ prismaContent: { $transaction: mockTransaction } }));
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateByPattern: jest.fn().mockResolvedValue(undefined),
    getOrSet: jest.fn(async (_key: string, loader: () => Promise<unknown>) => loader()),
  },
}));
jest.mock('../../../src/repositories', () => ({
  educationalResourceRepository: {
    existsByUrl: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  educationalCategoryRepository: {},
  readListItemRepository: {},
}));
jest.mock('../../../src/services/xp/xp.service', () => ({ xpService: { grantXp: jest.fn() } }));
jest.mock('../../../src/services/linkPreview/linkPreview.service', () => ({
  LinkPreviewService: { getInstance: jest.fn() },
}));

import { EducationalResourceService } from '../../../src/services/educational/educational-resource.service';
import { EducationalResourceAlreadyExistsError } from '../../../src/errors/educational.errors';
import { educationalResourceRepository } from '../../../src/repositories';
import { LinkPreviewService } from '../../../src/services/linkPreview/linkPreview.service';
import { xpService } from '../../../src/services/xp/xp.service';

const repo = educationalResourceRepository as unknown as {
  existsByUrl: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};
const grantXp = xpService.grantXp as jest.Mock;
const generatePreview = jest.fn();

const URL = 'https://example.com/a-guide';
const created = { id: 7, url: URL, addedBy: 3, linkPreviewId: null };
const input = { url: URL, addedBy: 3 };

describe('EducationalResourceService.create', () => {
  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
    repo.existsByUrl.mockResolvedValue(false);
    repo.create.mockImplementation(async () => {
      calls.push('repo:create');
      return created;
    });
    repo.update.mockImplementation(async (_id: number, data: object) => {
      calls.push('repo:update');
      return { ...created, ...data };
    });
    grantXp.mockImplementation(async () => {
      calls.push('xp');
      return 5;
    });
    generatePreview.mockReset();
    (LinkPreviewService.getInstance as jest.Mock).mockReturnValue({ generatePreview });
  });

  it('opens a single transaction (super.create\'s own) and fetches the preview after it committed, even a slow one', async () => {
    generatePreview.mockImplementation(async () => {
      calls.push('preview:start');
      await new Promise((resolve) => setTimeout(resolve, 50)); // stands for a slow fetch
      calls.push('preview:end');
      return { id: 'lp1' };
    });

    const result = await new EducationalResourceService().create(input);

    expect(result).toEqual({ ...created, linkPreviewId: 'lp1' });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'tx:start',
      'repo:create',
      'tx:commit',
      'preview:start',
      'preview:end',
      'repo:update',
      'xp',
    ]);
    expect(repo.update).toHaveBeenCalledWith(7, { linkPreviewId: 'lp1' });
  });

  it('keeps the resource without preview, and still grants the XP, when the preview fails', async () => {
    generatePreview.mockRejectedValue(new Error('fetch timed out'));

    const result = await new EducationalResourceService().create(input);

    expect(result).toEqual(created);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(repo.update).not.toHaveBeenCalled();
    expect(grantXp).toHaveBeenCalledTimes(1);
  });

  it('still resolves when the XP grant fails', async () => {
    generatePreview.mockResolvedValue({ id: 'lp1' });
    grantXp.mockRejectedValue(new Error('xp down'));

    await expect(new EducationalResourceService().create(input)).resolves.toEqual({
      ...created,
      linkPreviewId: 'lp1',
    });
  });

  it('answers alreadyExists without fetching a preview', async () => {
    repo.existsByUrl.mockResolvedValue(true);

    await expect(new EducationalResourceService().create(input)).rejects.toBeInstanceOf(
      EducationalResourceAlreadyExistsError
    );
    expect(generatePreview).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });
});
