import { Router, Request, Response, RequestHandler } from 'express';
import { LiquidationsService } from '../../services/liquidations/liquidations.service';
import { LiquidationQueryParams, LiquidationsError, ChartPeriod } from '../../types/liquidations.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import { liquidationsQuerySchema, recentLiquidationsQuerySchema } from '../../schemas/liquidations.schema';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const liquidationsService = LiquidationsService.getInstance();

// Apply rate limiter to all routes
router.use(marketRateLimiter);

/**
 * Parse validated query parameters into LiquidationQueryParams
 */
function parseQueryParams(query: Request['query']): LiquidationQueryParams {
  const params: LiquidationQueryParams = {};

  if (typeof query.coin === 'string') {
    params.coin = query.coin;
  }

  if (typeof query.user === 'string') {
    params.user = query.user;
  }

  if (typeof query.start_time === 'string') {
    params.start_time = query.start_time;
  }

  if (typeof query.end_time === 'string') {
    params.end_time = query.end_time;
  }

  // Hours parameter for time-based filtering
  if (query.hours !== undefined) {
    const hours = typeof query.hours === 'number'
      ? query.hours
      : parseInt(query.hours as string, 10);
    if (!isNaN(hours) && hours >= 1) {
      params.hours = hours;
    }
  }

  if (query.amount_dollars !== undefined) {
    const amount = typeof query.amount_dollars === 'number' 
      ? query.amount_dollars 
      : parseFloat(query.amount_dollars as string);
    if (!isNaN(amount) && amount >= 0) {
      params.amount_dollars = amount;
    }
  }

  if (query.limit !== undefined) {
    const limit = typeof query.limit === 'number'
      ? query.limit
      : parseInt(query.limit as string, 10);
    if (!isNaN(limit) && limit >= 1 && limit <= 1000) {
      params.limit = limit;
    }
  }

  if (typeof query.cursor === 'string') {
    params.cursor = query.cursor;
  }

  if (typeof query.order === 'string') {
    const order = query.order.toUpperCase();
    if (order === 'ASC' || order === 'DESC') {
      params.order = order;
    }
  }

  return params;
}

/**
 * GET /liquidations
 * Historical liquidations with filters and keyset pagination
 */
router.get('/',
  validateRequest(liquidationsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const params = parseQueryParams(req.query);
      
      logDeduplicator.info('GET /liquidations request', { params });

      const response = await liquidationsService.getLiquidations(params);

      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching liquidations:', { error });

      if (error instanceof LiquidationsError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          data: [],
          total_count: null,
          execution_time_ms: 0,
          next_cursor: null,
          has_more: false
        });
      }
      
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Internal server error',
        data: [],
        total_count: null,
        execution_time_ms: 0,
        next_cursor: null,
        has_more: false
      });
    }
  }) as RequestHandler
);

/**
 * GET /liquidations/chart-data
 * Get aggregated chart data for visualization
 * 
 * Query params:
 * - period: '2h' | '4h' | '8h' | '12h' | '24h' | '7d' | '30d' (default: '24h')
 */
router.get('/chart-data',
  (async (req: Request, res: Response) => {
    try {
      const periodParam = (req.query.period as string) || '24h';
      
      // Validate period
      const validPeriods: ChartPeriod[] = ['2h', '4h', '8h', '12h', '24h'];
      if (!validPeriods.includes(periodParam as ChartPeriod)) {
        return res.status(400).json({
          success: false,
          error: `Invalid period. Valid values: ${validPeriods.join(', ')}`
        });
      }

      const period = periodParam as ChartPeriod;
      logDeduplicator.info('GET /liquidations/chart-data request', { period });

      const response = await liquidationsService.getChartData(period);
      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching chart data:', { error });

      if (error instanceof LiquidationsError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message
        });
      }
      
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error'
      });
    }
  }) as RequestHandler
);

/**
 * GET /liquidations/data
 * Unified endpoint: stats + chart data for ALL periods in one call
 * Reduces API calls by 67% compared to separate /stats/all + /chart-data
 */
router.get('/data',
  (async (req: Request, res: Response) => {
    try {
      logDeduplicator.info('GET /liquidations/data request');

      const response = await liquidationsService.getAllData();
      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching unified liquidation data:', { error });

      if (error instanceof LiquidationsError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message
        });
      }
      
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error'
      });
    }
  }) as RequestHandler
);

/**
 * GET /liquidations/stats/all
 * Get aggregated stats for ALL time periods (2h, 4h, 8h, 12h, 24h) in one call
 * Uses sequential fetching and caching to avoid rate limiting
 */
router.get('/stats/all',
  (async (req: Request, res: Response) => {
    try {
      logDeduplicator.info('GET /liquidations/stats/all request');

      const response = await liquidationsService.getAllStats();

      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching all liquidation stats:', { error });

      if (error instanceof LiquidationsError) {
        return res.status(error.statusCode).json({
          success: false,
          stats: {
            '2h': null,
            '4h': null,
            '8h': null,
            '12h': null,
            '24h': null
          },
          errors: [error.message],
          metadata: {
            executionTimeMs: 0,
            cachedAt: new Date().toISOString()
          }
        });
      }
      
      res.status(500).json({
        success: false,
        stats: {
          '2h': null,
          '4h': null,
          '8h': null,
          '12h': null,
          '24h': null
        },
        errors: [error instanceof Error ? error.message : 'Internal server error'],
        metadata: {
          executionTimeMs: 0,
          cachedAt: new Date().toISOString()
        }
      });
    }
  }) as RequestHandler
);

/**
 * GET /liquidations/recent
 * Recent liquidations with hours parameter for time-based filtering
 * Supports: hours=2, hours=4, hours=8, hours=12, hours=24
 */
router.get('/recent',
  validateRequest(recentLiquidationsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const params = parseQueryParams(req.query);
      
      logDeduplicator.info('GET /liquidations/recent request', { params });

      const response = await liquidationsService.getRecentLiquidations(params);

      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching recent liquidations:', { error });

      if (error instanceof LiquidationsError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          data: [],
          total_count: null,
          execution_time_ms: 0,
          next_cursor: null,
          has_more: false
        });
      }
      
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Internal server error',
        data: [],
        total_count: null,
        execution_time_ms: 0,
        next_cursor: null,
        has_more: false
      });
    }
  }) as RequestHandler
);

export default router;
