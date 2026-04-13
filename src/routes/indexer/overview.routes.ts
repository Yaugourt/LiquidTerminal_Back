import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerOverviewCoinDistributionQuerySchema,
  indexerOverviewEmptyQuerySchema,
} from '../../schemas/indexer/overview-indexer.schema';
import { IndexerOverviewService } from '../../services/indexer/indexer-overview.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = IndexerOverviewService.getInstance();

function wrap(handler: () => Promise<unknown>, label: string): RequestHandler {
  return (async (_req, res: Response) => {
    try {
      const data = await handler();
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error(label, { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_OVERVIEW_ERROR',
      });
    }
  }) as RequestHandler;
}

router.get(
  '/active-traders-24h',
  marketRateLimiter,
  validateGetRequest(indexerOverviewEmptyQuerySchema),
  wrap(() => service.getActiveTraders24h(), 'GET /indexer/overview/active-traders-24h')
);

router.get(
  '/coin-distribution',
  marketRateLimiter,
  validateGetRequest(indexerOverviewCoinDistributionQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const user = req.query.user as string;
      const data = await service.getCoinDistribution(user);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/overview/coin-distribution', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_OVERVIEW_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/daily-pnl-10d',
  marketRateLimiter,
  validateGetRequest(indexerOverviewEmptyQuerySchema),
  wrap(() => service.getDailyPnl10d(), 'GET /indexer/overview/daily-pnl-10d')
);

router.get(
  '/daily-volume-10d',
  marketRateLimiter,
  validateGetRequest(indexerOverviewEmptyQuerySchema),
  wrap(() => service.getDailyVolume10d(), 'GET /indexer/overview/daily-volume-10d')
);

router.get(
  '/total-fees-24h',
  marketRateLimiter,
  validateGetRequest(indexerOverviewEmptyQuerySchema),
  wrap(() => service.getTotalFees24h(), 'GET /indexer/overview/total-fees-24h')
);

router.get(
  '/total-fills-24h',
  marketRateLimiter,
  validateGetRequest(indexerOverviewEmptyQuerySchema),
  wrap(() => service.getTotalFills24h(), 'GET /indexer/overview/total-fills-24h')
);

router.get(
  '/trading-volume-24h',
  marketRateLimiter,
  validateGetRequest(indexerOverviewEmptyQuerySchema),
  wrap(() => service.getTradingVolume24h(), 'GET /indexer/overview/trading-volume-24h')
);

export default router;
