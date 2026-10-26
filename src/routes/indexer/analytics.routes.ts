import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter, passthroughRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerAnalyticsFillsStatsQuerySchema,
  indexerAnalyticsPriorityFeesStatsQuerySchema,
} from '../../schemas/indexer/analytics.schema';
import { IndexerAnalyticsService } from '../../services/indexer/indexer-analytics.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { sendUpstreamError } from '../../utils/upstream-error-response';

const router = Router();
const service = IndexerAnalyticsService.getInstance();

router.get(
  '/fills/stats',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(indexerAnalyticsFillsStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { hours, coin } = req.query;
      const upstream = await service.getFillsStats({
        hours: hours !== undefined ? Number(hours) : undefined,
        coin: typeof coin === 'string' ? coin : undefined,
      });
      res.json({ success: true, data: upstream });
    } catch (error) {
      logDeduplicator.error('GET /indexer/analytics/fills/stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      sendUpstreamError(res, error, 502, {
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_ANALYTICS_FILLS_STATS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/priority-fees/stats',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(indexerAnalyticsPriorityFeesStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { hours, coin } = req.query;
      const upstream = await service.getPriorityFeesStats({
        hours: hours !== undefined ? Number(hours) : undefined,
        coin: typeof coin === 'string' ? coin : undefined,
      });
      res.json({ success: true, data: upstream });
    } catch (error) {
      logDeduplicator.error('GET /indexer/analytics/priority-fees/stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      sendUpstreamError(res, error, 502, {
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_ANALYTICS_PRIORITY_FEES_STATS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
