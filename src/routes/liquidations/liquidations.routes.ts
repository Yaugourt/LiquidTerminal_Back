import { Router, Request, Response, RequestHandler } from 'express';
import { LiquidationsService } from '../../services/liquidations/liquidations.service';
import { SSEManagerService } from '../../services/liquidations/sse-manager.service';
import { LiquidationQueryParams, LiquidationsError, ChartPeriod } from '../../types/liquidations.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import { liquidationsQuerySchema, recentLiquidationsQuerySchema } from '../../schemas/liquidations.schema';
import { sseStreamQuerySchema } from '../../schemas/sse.schema';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const liquidationsService = LiquidationsService.getInstance();
const sseManager = SSEManagerService.getInstance();

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
  marketRateLimiter,
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
  marketRateLimiter,
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
  marketRateLimiter,
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
  marketRateLimiter,
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
  marketRateLimiter,
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

/**
 * GET /liquidations/stream
 * Server-Sent Events endpoint for real-time liquidation updates
 *
 * Query params:
 * - coin: Filter by coin (optional, e.g., "BTC")
 * - min_amount_dollars: Minimum notional value filter (optional)
 * - last_event_id: Resume from this event ID (optional)
 *
 * Headers:
 * - Last-Event-ID: Alternative way to specify resume point (SSE standard)
 *
 * Note: This route does NOT use marketRateLimiter - SSE has its own connection limits
 */
router.get('/stream',
  validateRequest(sseStreamQuerySchema),
  (async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    // Parse filters from query
    const filters = {
      coin: req.query.coin as string | undefined,
      minAmountDollars: req.query.min_amount_dollars
        ? parseFloat(String(req.query.min_amount_dollars))
        : undefined
    };

    // Get last event ID (from query or header)
    const lastEventId = req.query.last_event_id
      ? parseInt(String(req.query.last_event_id), 10)
      : req.headers['last-event-id']
        ? parseInt(String(req.headers['last-event-id']), 10)
        : undefined;

    logDeduplicator.info('SSE stream request', { ip, filters, lastEventId });

    // Add client
    const clientId = await sseManager.addClient(res, ip, filters, lastEventId);

    if (!clientId) {
      return res.status(429).json({
        success: false,
        error: 'Connection limit reached',
        code: 'SSE_CONNECTION_LIMIT'
      });
    }

    // Handle client disconnect
    req.on('close', () => {
      sseManager.removeClient(clientId);
    });

    req.on('error', () => {
      sseManager.removeClient(clientId);
    });

    // Keep connection open - response handled by SSE manager
  }) as RequestHandler
);

/**
 * GET /liquidations/stream/stats
 * Get current SSE connection statistics (for monitoring)
 */
router.get('/stream/stats',
  marketRateLimiter,
  (async (_req: Request, res: Response) => {
    const stats = sseManager.getStats();
    res.json({
      success: true,
      data: stats
    });
  }) as RequestHandler
);

export default router;
