import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerAnalyticsFillsStatsQuerySchema,
  indexerAnalyticsPriorityFeesStatsQuerySchema,
  indexerAnalyticsPriorityFeesFillsTimeseriesQuerySchema,
} from '../../schemas/indexer/analytics.schema';
import { IndexerAnalyticsService } from '../../services/indexer/indexer-analytics.service';
import { IndexerPriorityFeesAggregationService } from '../../services/indexer/indexer-priority-fees-aggregation.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { unwrapHypeDexerApiPayload } from '../../utils/hypedexer-api-response.util';

const router = Router();
const service = IndexerAnalyticsService.getInstance();
const priorityFeesAggregation = IndexerPriorityFeesAggregationService.getInstance();

router.get(
  '/fills/stats',
  marketRateLimiter,
  validateGetRequest(indexerAnalyticsFillsStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { hours, coin } = req.query;
      const upstream = await service.getFillsStats({
        hours: hours !== undefined ? Number(hours) : undefined,
        coin: typeof coin === 'string' ? coin : undefined,
      });
      res.json({ success: true, data: unwrapHypeDexerApiPayload(upstream) });
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

router.get(
  '/priority-fees/stats',
  marketRateLimiter,
  validateGetRequest(indexerAnalyticsPriorityFeesStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { hours, coin } = req.query;
      const upstream = await service.getPriorityFeesStats({
        hours: hours !== undefined ? Number(hours) : undefined,
        coin: typeof coin === 'string' ? coin : undefined,
      });
      res.json({ success: true, data: unwrapHypeDexerApiPayload(upstream) });
    } catch (error) {
      logDeduplicator.error('GET /indexer/analytics/priority-fees/stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_ANALYTICS_PRIORITY_FEES_STATS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/priority-fees/fills-timeseries',
  marketRateLimiter,
  validateGetRequest(indexerAnalyticsPriorityFeesFillsTimeseriesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const parsed = indexerAnalyticsPriorityFeesFillsTimeseriesQuerySchema.parse({
        query: req.query,
        params: {},
      });
      const { hours, bucket_hours } = parsed.query;
      const data = await priorityFeesAggregation.getFillsPriorityGasTimeseries({
        hours,
        bucketHours: bucket_hours,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/analytics/priority-fees/fills-timeseries', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_ANALYTICS_PRIORITY_FEES_FILLS_TIMESERIES_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
