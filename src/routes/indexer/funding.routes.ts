import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerFundingHistoryQuerySchema,
  indexerFundingPredictedQuerySchema,
  indexerFundingUserFundingQuerySchema,
} from '../../schemas/indexer/funding.schema';
import { IndexerFundingService } from '../../services/indexer/indexer-funding.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = IndexerFundingService.getInstance();

router.get(
  '/fundingHistory',
  marketRateLimiter,
  validateGetRequest(indexerFundingHistoryQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { coin, startTime, endTime, limit } = req.query;
      const data = await service.getFundingHistory({
        coin: coin as string,
        startTime: typeof startTime === 'string' ? startTime : undefined,
        endTime: typeof endTime === 'string' ? endTime : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/funding/fundingHistory', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_FUNDING_HISTORY_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/predictedFundings',
  marketRateLimiter,
  validateGetRequest(indexerFundingPredictedQuerySchema),
  (async (_req: Request, res: Response) => {
    try {
      const data = await service.getPredictedFundings();
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/funding/predictedFundings', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_FUNDING_PREDICTED_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/userFunding',
  marketRateLimiter,
  validateGetRequest(indexerFundingUserFundingQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { user, startTime, endTime, limit } = req.query;
      const data = await service.getUserFunding({
        user: user as string,
        startTime: typeof startTime === 'string' ? startTime : undefined,
        endTime: typeof endTime === 'string' ? endTime : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/funding/userFunding', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_FUNDING_USER_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
