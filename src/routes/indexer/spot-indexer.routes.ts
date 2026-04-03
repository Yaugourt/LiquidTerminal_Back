import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  spotAuctionsHistQuerySchema,
  spotAuctionsLiveQuerySchema,
  spotPairsQuerySchema,
  spotTokensQuerySchema,
} from '../../schemas/indexer/spot-indexer.schema';
import { IndexerSpotIndexerService } from '../../services/indexer/indexer-spot-indexer.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const svc = IndexerSpotIndexerService.getInstance();

function num(q: unknown): number | undefined {
  if (q === undefined || q === '') return undefined;
  const n = Number(q);
  return Number.isFinite(n) ? n : undefined;
}

function str(q: unknown): string | undefined {
  return typeof q === 'string' ? q : undefined;
}

router.get(
  '/auctions/hist',
  marketRateLimiter,
  validateGetRequest(spotAuctionsHistQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { lookback_hours, limit, offset } = req.query;
      res.json({
        success: true,
        data: await svc.getAuctionsHist({
          lookback_hours: num(lookback_hours),
          limit: num(limit),
          offset: num(offset),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/spot/auctions/hist', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_SPOT_AUCTIONS_HIST_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/auctions/live',
  marketRateLimiter,
  validateGetRequest(spotAuctionsLiveQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        data: await svc.getAuctionsLive({ freshness_sec: num(req.query.freshness_sec) }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/spot/auctions/live', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_SPOT_AUCTIONS_LIVE_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/pairs',
  marketRateLimiter,
  validateGetRequest(spotPairsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { limit, offset } = req.query;
      res.json({
        success: true,
        data: await svc.getPairs({ limit: num(limit), offset: num(offset) }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/spot/pairs', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_SPOT_PAIRS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/tokens',
  marketRateLimiter,
  validateGetRequest(spotTokensQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { search, limit, offset } = req.query;
      res.json({
        success: true,
        data: await svc.getTokens({
          search: str(search),
          limit: num(limit),
          offset: num(offset),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/spot/tokens', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_SPOT_TOKENS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
