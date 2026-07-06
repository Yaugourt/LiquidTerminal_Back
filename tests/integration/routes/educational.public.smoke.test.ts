/**
 * Smoke tests for the public wiki v2 endpoints:
 * - GET /educational/resources must go through getPublicResources (APPROVED only)
 * - categoryIds CSV query param validates (and rejects garbage)
 * - GET /educational/categories?withCounts=true routes to getAllWithCounts
 * Services are mocked; this suite only asserts route wiring + validation.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(),
  },
}));

jest.mock('../../../src/middleware/authMiddleware', () => ({
  validatePrivyToken: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../../../src/middleware/roleMiddleware', () => ({
  requireUser: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireModerator: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../../../src/middleware/contributionRateLimiter', () => ({
  contributionRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  recordContribution: jest.fn(),
}));

const emptyPagination = { page: 1, limit: 10, total: 0, totalPages: 0, hasNext: false, hasPrevious: false };
const getPublicResources = jest.fn().mockResolvedValue({ data: [], pagination: emptyPagination });
const getAllResources = jest.fn().mockResolvedValue({ data: [], pagination: emptyPagination });
const getResourcesByCategory = jest.fn().mockResolvedValue([]);

jest.mock('../../../src/services/educational/educational-resource.service', () => ({
  EducationalResourceService: jest.fn().mockImplementation(() => ({
    getPublicResources,
    getAll: getAllResources,
    getResourcesByCategory,
  })),
}));

jest.mock('../../../src/services/educational/resource-report.service', () => ({
  resourceReportService: {},
}));

const getAllCategories = jest.fn().mockResolvedValue({ data: [], pagination: emptyPagination });
const getAllWithCounts = jest.fn().mockResolvedValue({ data: [], pagination: emptyPagination });

jest.mock('../../../src/services/educational/educational-category.service', () => ({
  EducationalCategoryService: jest.fn().mockImplementation(() => ({
    getAll: getAllCategories,
    getAllWithCounts,
    getResourcesByCategory: jest.fn().mockResolvedValue([]),
  })),
}));

import educationalResourceRoutes from '../../../src/routes/educational/educational-resource.routes';
import educationalCategoryRoutes from '../../../src/routes/educational/educational-category.routes';

const app = express();
app.use(express.json());
app.use('/educational/resources', educationalResourceRoutes);
app.use('/educational/categories', educationalCategoryRoutes);

describe('wiki v2 public routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPublicResources.mockResolvedValue({ data: [], pagination: emptyPagination });
    getAllCategories.mockResolvedValue({ data: [], pagination: emptyPagination });
    getAllWithCounts.mockResolvedValue({ data: [], pagination: emptyPagination });
  });

  describe('GET /educational/resources', () => {
    it('uses getPublicResources, never the unfiltered getAll', async () => {
      const res = await request(app).get('/educational/resources');
      expect(res.status).toBe(200);
      expect(getPublicResources).toHaveBeenCalledTimes(1);
      expect(getAllResources).not.toHaveBeenCalled();
    });

    it('accepts categoryIds as CSV', async () => {
      const res = await request(app).get('/educational/resources?categoryIds=1,2,3');
      expect(res.status).toBe(200);
      expect(getPublicResources).toHaveBeenCalledWith(
        expect.objectContaining({ categoryIds: '1,2,3' })
      );
    });

    it('accepts repeated categoryIds params', async () => {
      const res = await request(app).get('/educational/resources?categoryIds=1&categoryIds=2');
      expect(res.status).toBe(200);
    });

    it('rejects non-numeric categoryIds', async () => {
      const res = await request(app).get('/educational/resources?categoryIds=abc');
      expect(res.status).toBe(400);
      expect(getPublicResources).not.toHaveBeenCalled();
    });
  });

  describe('GET /educational/categories', () => {
    it('uses getAll by default', async () => {
      const res = await request(app).get('/educational/categories');
      expect(res.status).toBe(200);
      expect(getAllCategories).toHaveBeenCalledTimes(1);
      expect(getAllWithCounts).not.toHaveBeenCalled();
    });

    it('routes withCounts=true to getAllWithCounts', async () => {
      const res = await request(app).get('/educational/categories?withCounts=true');
      expect(res.status).toBe(200);
      expect(getAllWithCounts).toHaveBeenCalledTimes(1);
      expect(getAllCategories).not.toHaveBeenCalled();
    });

    it('rejects an invalid withCounts value', async () => {
      const res = await request(app).get('/educational/categories?withCounts=yes');
      expect(res.status).toBe(400);
    });
  });
});
