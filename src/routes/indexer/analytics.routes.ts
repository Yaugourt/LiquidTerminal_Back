import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import { indexerAnalyticsFillsStatsQuerySchema } from '../../schemas/indexer/analytics.schema';
import { IndexerAnalyticsService } from '../../services/indexer/indexer-analytics.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = IndexerAnalyticsService.getInstance();

router.get(
  '/fills/stats',
  marketRateLimiter,
  validateGetRequest(indexerAnalyticsFillsStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { hours, coin } = req.query;
      const data = await service.getFillsStats({
        hours: hours !== undefined ? Number(hours) : undefined,
        coin: typeof coin === 'string' ? coin : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/analytics/fills/stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_ANALYTICS_FILLS_STATS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
