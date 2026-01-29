import { Router, Request, Response, RequestHandler } from 'express';
import { TopTradersService } from '../../services/toptraders/toptraders.service';
import { TopTradersQueryParams, TopTradersError, TopTradersSortType } from '../../types/toptraders.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import { topTradersQuerySchema } from '../../schemas/toptraders.schema';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const topTradersService = TopTradersService.getInstance();

/**
 * Parse validated query parameters into TopTradersQueryParams
 */
function parseQueryParams(query: Request['query']): TopTradersQueryParams {
  const params: TopTradersQueryParams = {};

  if (typeof query.sort === 'string') {
    const validSorts: TopTradersSortType[] = ['pnl_pos', 'pnl_neg', 'volume', 'trades'];
    if (validSorts.includes(query.sort as TopTradersSortType)) {
      params.sort = query.sort as TopTradersSortType;
    }
  }

  if (query.limit !== undefined) {
    const limit = typeof query.limit === 'number'
      ? query.limit
      : parseInt(query.limit as string, 10);
    if (!isNaN(limit) && limit >= 1 && limit <= 50) {
      params.limit = limit;
    }
  }

  return params;
}

/**
 * GET /top-traders
 * Get top traders for the last 24 hours
 *
 * Query params:
 * - sort: 'pnl_pos' | 'pnl_neg' | 'volume' | 'trades' (default: 'pnl_pos')
 *   - pnl_pos: Top positive PnL (most profitable)
 *   - pnl_neg: Top negative PnL (biggest losers)
 *   - volume: Top by trading volume
 *   - trades: Top by number of trades
 * - limit: 1-50 (default: 50)
 *
 * Response:
 * {
 *   success: true,
 *   data: [
 *     {
 *       user: "0x...",
 *       tradeCount: 12,
 *       totalVolume: 140672857.22,
 *       winRate: 0.25,
 *       totalPnl: 3020765.79
 *     }
 *   ],
 *   metadata: {
 *     sort: "pnl_pos",
 *     limit: 50,
 *     executionTimeMs: 42.24,
 *     cachedAt: "2026-01-29T10:00:00.000Z"
 *   }
 * }
 */
router.get('/',
  marketRateLimiter,
  validateRequest(topTradersQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const params = parseQueryParams(req.query);

      logDeduplicator.info('GET /top-traders request', { params });

      const response = await topTradersService.getTopTraders(params);

      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching top traders:', { error });

      if (error instanceof TopTradersError) {
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
