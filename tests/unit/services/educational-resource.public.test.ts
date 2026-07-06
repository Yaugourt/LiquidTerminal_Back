/**
 * Unit coverage for the wiki v2 public contract:
 * - getPublicResources always forces status APPROVED (caller cannot override)
 * - educationalResourceQuerySchema normalizes categoryIds (CSV or repeated)
 */
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(),
  },
}));

// The service module pulls the whole Prisma/repository wiring at import time;
// stub it out, this suite only exercises pure logic (prototype call + Zod).
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/prisma.content.service', () => ({ prismaContent: {} }));
jest.mock('../../../src/core/cache.service', () => ({ cacheService: {} }));
jest.mock('../../../src/repositories', () => ({
  educationalResourceRepository: {},
  educationalCategoryRepository: {},
}));
jest.mock('../../../src/services/xp/xp.service', () => ({ xpService: {} }));
jest.mock('../../../src/services/linkPreview/linkPreview.service', () => ({
  LinkPreviewService: { getInstance: jest.fn() },
}));

import { EducationalResourceService } from '../../../src/services/educational/educational-resource.service';
import { educationalResourceQuerySchema } from '../../../src/schemas/educational.schema';

describe('EducationalResourceService.getPublicResources', () => {
  it('forces status APPROVED even when the caller passes another status', async () => {
    const getAll = jest.fn().mockResolvedValue({ data: [], pagination: {} });
    // Invoke the real prototype method against a stub `this` to avoid the
    // repository/prisma wiring of the full service constructor.
    await EducationalResourceService.prototype.getPublicResources.call(
      { getAll },
      { status: 'PENDING', page: 2, search: 'hyperliquid' }
    );

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED', page: 2, search: 'hyperliquid' })
    );
  });
});

describe('educationalResourceQuerySchema categoryIds', () => {
  it('parses a CSV string into a number array', () => {
    const parsed = educationalResourceQuerySchema.parse({ categoryIds: '1,2,3' });
    expect(parsed.categoryIds).toEqual([1, 2, 3]);
  });

  it('parses repeated params (string array) into a number array', () => {
    const parsed = educationalResourceQuerySchema.parse({ categoryIds: ['4', '5'] });
    expect(parsed.categoryIds).toEqual([4, 5]);
  });

  it('leaves categoryIds undefined when absent or empty', () => {
    expect(educationalResourceQuerySchema.parse({}).categoryIds).toBeUndefined();
    expect(educationalResourceQuerySchema.parse({ categoryIds: '' }).categoryIds).toBeUndefined();
  });

  it('rejects non-numeric values', () => {
    expect(() => educationalResourceQuerySchema.parse({ categoryIds: 'abc' })).toThrow();
    expect(() => educationalResourceQuerySchema.parse({ categoryIds: '1,abc' })).toThrow();
  });

  it('accepts a valid status filter (service-level only)', () => {
    const parsed = educationalResourceQuerySchema.parse({ status: 'APPROVED' });
    expect(parsed.status).toBe('APPROVED');
  });
});
