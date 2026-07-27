import { Router, Request, Response, RequestHandler } from 'express';
import { BuildersService } from '../../services/builders/builders.service';
import { BuildersQueryParams, BuildersError, BuildersSortField, BuildersSortOrder } from '../../types/builders.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import { buildersListQuerySchema, buildersStatsQuerySchema } from '../../schemas/builders.schema';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const buildersService = BuildersService.getInstance();

/**
 * Parse validated query parameters into BuildersQueryParams
 */
function parseQueryParams(query: Request['query']): BuildersQueryParams {
  const params: BuildersQueryParams = {};

  if (query.page !== undefined) {
    const page = typeof query.page === 'number' ? query.page : parseInt(query.page as string, 10);
    if (!isNaN(page) && page >= 1) params.page = page;
  }

  if (query.limit !== undefined) {
    const limit = typeof query.limit === 'number' ? query.limit : parseInt(query.limit as string, 10);
    if (!isNaN(limit) && limit >= 1 && limit <= 100) params.limit = limit;
  }

  if (typeof query.sortBy === 'string') {
    const validSorts: BuildersSortField[] = ['volume_usd', 'fees_usd', 'trades_count', 'unique_users', 'name'];
    if (validSorts.includes(query.sortBy as BuildersSortField)) {
      params.sortBy = query.sortBy as BuildersSortField;
    }
  }

  if (typeof query.sortOrder === 'string') {
    const validOrders: BuildersSortOrder[] = ['asc', 'desc'];
    if (validOrders.includes(query.sortOrder as BuildersSortOrder)) {
      params.sortOrder = query.sortOrder as BuildersSortOrder;
    }
  }

  if (typeof query.search === 'string' && query.search.trim()) {
    params.search = query.search.trim();
  }

  return params;
}

/**
 * GET /builders
 * List all builders with pagination, sorting and search
 */
router.get('/',
  marketRateLimiter,
  validateRequest(buildersListQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const params = parseQueryParams(req.query);

      logDeduplicator.info('GET /builders request', { params });

      const response = await buildersService.getBuilders(params);

      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching builders:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof BuildersError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code
        });
      }

      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

/**
 * GET /builders/stats
 * Get aggregated stats for all builders
 */
router.get('/stats',
  marketRateLimiter,
  validateRequest(buildersStatsQuerySchema),
  (async (_req: Request, res: Response) => {
    try {
      logDeduplicator.info('GET /builders/stats request');

      const response = await buildersService.getStats();

      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching builders stats:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof BuildersError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code
        });
      }

      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

export default router;
