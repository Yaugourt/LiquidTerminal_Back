/**
 * generatePreview looks the URL up through getOrSet, which stores a miss (null) too.
 * The freshly generated preview must replace that miss, or every request for the next
 * hour finds "null", fetches the page and writes the row again. isUsedByOtherResources
 * must fail safe: an error means "in use", so the shared preview is never deleted.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/repositories', () => ({
  linkPreviewRepository: { findByUrl: jest.fn(), upsert: jest.fn() },
}));
jest.mock('../../../src/core/prisma.content.service', () => ({
  prismaContent: { educationalResource: { count: jest.fn() } },
}));
jest.mock('../../../src/services/linkPreview/linkPreviewFetcher.service', () => ({
  LinkPreviewFetcherService: { getInstance: () => ({ fetchPreviewData: mockFetchPreviewData }) },
}));

// Same contract as the real cache: whatever is stored, even "null", is a hit.
const mockStore = new Map<string, string>();
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: {
    getOrSet: jest.fn(async (key: string, load: () => Promise<unknown>) => {
      const hit = mockStore.get(key);
      if (hit) return JSON.parse(hit);
      const data = await load();
      mockStore.set(key, JSON.stringify(data));
      return data;
    }),
    invalidate: jest.fn(async (key: string) => {
      mockStore.delete(key);
    }),
  },
}));
const mockFetchPreviewData = jest.fn();

import { LinkPreviewService } from '../../../src/services/linkPreview/linkPreview.service';
import { linkPreviewRepository } from '../../../src/repositories';
import { prismaContent } from '../../../src/core/prisma.content.service';

const repo = linkPreviewRepository as unknown as { findByUrl: jest.Mock; upsert: jest.Mock };
const count = (prismaContent as unknown as { educationalResource: { count: jest.Mock } }).educationalResource.count;

describe('LinkPreviewService.generatePreview cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
  });

  it('serves the second request for a new URL from the cache', async () => {
    repo.findByUrl.mockResolvedValue(null);
    mockFetchPreviewData.mockResolvedValue({ title: 'Liquid Terminal' });
    repo.upsert.mockResolvedValue({ id: 'p1', url: 'https://lt.test', title: 'Liquid Terminal' });
    const service = LinkPreviewService.getInstance();

    const first = await service.generatePreview('https://lt.test');
    const second = await service.generatePreview('https://lt.test');

    expect(first.id).toBe('p1');
    expect(second.id).toBe('p1');
    expect(mockFetchPreviewData).toHaveBeenCalledTimes(1);
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('LinkPreviewService.isUsedByOtherResources', () => {
  const service = () => LinkPreviewService.getInstance();

  it('counts other resources', async () => {
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    expect(await service().isUsedByOtherResources('p1', 5)).toBe(false);
    expect(await service().isUsedByOtherResources('p1', 5)).toBe(true);
  });

  it('treats a failed check as in use', async () => {
    count.mockRejectedValueOnce(new Error('content db down'));
    expect(await service().isUsedByOtherResources('p1', 5)).toBe(true);
  });
});
