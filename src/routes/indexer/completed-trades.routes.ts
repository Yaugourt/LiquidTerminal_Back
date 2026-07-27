import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerCompletedTradesListQuerySchema,
  indexerCompletedTradesSummaryQuerySchema,
  indexerCompletedTradesFillsParamsSchema,
} from '../../schemas/indexer/completed-trades.schema';
import { IndexerCompletedTradesService } from '../../services/indexer/indexer-completed-trades.service';
import type {
  IndexerCompletedTradesQuery,
  IndexerCompletedTradesSummaryQuery,
} from '../../clients/hypedexer/rest/completed-trades/completed-trades.client';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = IndexerCompletedTradesService.getInstance();

function listQueryFromRequest(query: Request['query']): IndexerCompletedTradesQuery {
  const params: IndexerCompletedTradesQuery = {};
  if (typeof query.user === 'string') params.user = query.user;
  if (typeof query.coin === 'string') params.coin = query.coin;
  if (typeof query.direction === 'string') params.direction = query.direction;
  if (typeof query.start_time === 'string') params.start_time = query.start_time;
  if (typeof query.end_time === 'string') params.end_time = query.end_time;
  if (query.min_pnl !== undefined) params.min_pnl = Number(query.min_pnl);
  if (query.max_pnl !== undefined) params.max_pnl = Number(query.max_pnl);
  if (query.offset !== undefined) params.offset = Number(query.offset);
  if (query.limit !== undefined) params.limit = Number(query.limit);
  if (query.do_count !== undefined) {
    const dc = query.do_count;
    params.do_count =
      dc === 'true' ||
      dc === '1' ||
      (Array.isArray(dc) ? dc[0] === 'true' || dc[0] === '1' : false);
  }
  if (typeof query.sort_by === 'string') params.sort_by = query.sort_by;
  if (typeof query.sort_dir === 'string') params.sort_dir = query.sort_dir;
  return params;
}

function summaryQueryFromRequest(query: Request['query']): IndexerCompletedTradesSummaryQuery {
  const params: IndexerCompletedTradesSummaryQuery = {};
  if (typeof query.user === 'string') params.user = query.user;
  if (typeof query.coin === 'string') params.coin = query.coin;
  if (typeof query.direction === 'string') params.direction = query.direction;
  if (typeof query.start_time === 'string') params.start_time = query.start_time;
  if (typeof query.end_time === 'string') params.end_time = query.end_time;
  return params;
}

router.get(
  '/summary',
  marketRateLimiter,
  validateGetRequest(indexerCompletedTradesSummaryQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const data = await service.getSummary(summaryQueryFromRequest(req.query));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/completed-trades/summary', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_COMPLETED_TRADES_SUMMARY_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:trade_id/fills',
  marketRateLimiter,
  validateGetRequest(indexerCompletedTradesFillsParamsSchema),
  (async (req: Request, res: Response) => {
    try {
      const tradeId = String(req.params.trade_id);
      const data = await service.getTradeFills(tradeId);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/completed-trades/:trade_id/fills', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_COMPLETED_TRADE_FILLS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/',
  marketRateLimiter,
  validateGetRequest(indexerCompletedTradesListQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const data = await service.listCompletedTrades(listQueryFromRequest(req.query));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/completed-trades', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_COMPLETED_TRADES_LIST_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
