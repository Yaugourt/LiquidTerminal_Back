import { Router, Request, Response } from 'express';
import { HLIndexerLiquidationsClient } from '../../clients/hlindexer/liquidations/liquidations.client';
import { LiquidationQueryParams, LiquidationsError } from '../../types/liquidations.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const liquidationsClient = HLIndexerLiquidationsClient.getInstance();

/**
 * Parse and validate query parameters from request
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

  if (typeof query.amount_dollars === 'string') {
    const amount = parseFloat(query.amount_dollars);
    if (!isNaN(amount) && amount >= 0) {
      params.amount_dollars = amount;
    }
  }

  if (typeof query.limit === 'string') {
    const limit = parseInt(query.limit, 10);
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
router.get('/', async (req: Request, res: Response) => {
  try {
    const params = parseQueryParams(req.query);
    
    logDeduplicator.info('GET /liquidations request', { params });

    const response = await liquidationsClient.getLiquidations(params);

    res.json(response);
  } catch (error) {
    logDeduplicator.error('Error fetching liquidations:', { error });

    if (error instanceof LiquidationsError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        data: [],
        total_count: null,
        execution_time_ms: 0,
        next_cursor: null,
        has_more: false
      });
    } else {
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
  }
});

/**
 * GET /liquidations/recent
 * Recent liquidations (2h window by default if no filter)
 */
router.get('/recent', async (req: Request, res: Response) => {
  try {
    const params = parseQueryParams(req.query);
    
    logDeduplicator.info('GET /liquidations/recent request', { params });

    const response = await liquidationsClient.getRecentLiquidations(params);

    res.json(response);
  } catch (error) {
    logDeduplicator.error('Error fetching recent liquidations:', { error });

    if (error instanceof LiquidationsError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        data: [],
        total_count: null,
        execution_time_ms: 0,
        next_cursor: null,
        has_more: false
      });
    } else {
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
  }
});

export default router;
