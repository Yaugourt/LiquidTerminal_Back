import { Router, Request, Response, RequestHandler } from 'express';
import { ActiveUsersService } from '../../services/activeusers/activeusers.service';
import { ActiveUsersQueryParams, ActiveUsersError } from '../../types/activeusers.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import { activeUsersQuerySchema } from '../../schemas/activeusers.schema';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const activeUsersService = ActiveUsersService.getInstance();

/**
 * Parse validated query parameters into ActiveUsersQueryParams
 */
function parseQueryParams(query: Request['query']): ActiveUsersQueryParams {
  const params: ActiveUsersQueryParams = {};

  if (query.hours !== undefined) {
    const hours = typeof query.hours === 'number'
      ? query.hours
      : parseInt(query.hours as string, 10);
    if (!isNaN(hours) && hours >= 1 && hours <= 168) {
      params.hours = hours;
    }
  }

  if (query.limit !== undefined) {
    const limit = typeof query.limit === 'number'
      ? query.limit
      : parseInt(query.limit as string, 10);
    if (!isNaN(limit) && limit >= 1 && limit <= 100) {
      params.limit = limit;
    }
  }

  return params;
}

/**
 * GET /active-users
 * Get most active users for the specified time window
 *
 * Query params:
 * - hours: 1-168 (default: 24) - Lookback window in hours
 * - limit: 1-100 (default: 100) - Max users to return
 *
 * Response:
 * {
 *   success: true,
 *   data: [
 *     {
 *       user: "0x...",
 *       fill_count: 201882,
 *       total_volume: 959383701.20,
 *       unique_coins: 11,
 *       last_activity: "2026-01-29T23:00:55"
 *     }
 *   ],
 *   metadata: {
 *     hours: 24,
 *     limit: 100,
 *     totalCount: 100,
 *     executionTimeMs: 1074.92,
 *     cachedAt: "2026-01-29T10:00:00.000Z"
 *   }
 * }
 */
router.get('/',
  marketRateLimiter,
  validateRequest(activeUsersQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const params = parseQueryParams(req.query);

      logDeduplicator.info('GET /active-users request', { params });

      const response = await activeUsersService.getActiveUsers(params);

      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching active users:', { error });

      if (error instanceof ActiveUsersError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code
        });
      }

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

export default router;
