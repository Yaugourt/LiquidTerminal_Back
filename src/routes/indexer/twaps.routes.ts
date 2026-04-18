import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  twapsListQuerySchema,
  twapsStatsQuerySchema,
  twapsUserQuerySchema,
  twapsByIdParamsSchema,
  twapsFillsQuerySchema,
} from '../../schemas/indexer/twaps.schema';
import { IndexerTwapsService } from '../../services/indexer/indexer-twaps.service';
import { sendIndexerHypeDexerSuccess } from '../../utils/indexer-hypedexer-response.util';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const svc = IndexerTwapsService.getInstance();

function num(q: unknown): number | undefined {
  if (q === undefined || q === '') return undefined;
  const n = Number(q);
  return Number.isFinite(n) ? n : undefined;
}

function str(q: unknown): string | undefined {
  return typeof q === 'string' ? q : undefined;
}

router.get(
  '/stats',
  marketRateLimiter,
  validateGetRequest(twapsStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { hours, coin } = req.query;
      res.json({
        success: true,
        data: await svc.getStats({ hours: num(hours), coin: str(coin) }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps/stats', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_TWAPS_STATS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/user/:user_address',
  marketRateLimiter,
  validateGetRequest(twapsUserQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const userAddress = String(req.params.user_address);
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getUserTwaps(userAddress, {
          status: str(q.status),
          coin: str(q.coin),
          hours: num(q.hours),
          limit: num(q.limit),
          offset: num(q.offset),
          order: str(q.order),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps/user/:user_address', {
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_TWAPS_USER_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/',
  marketRateLimiter,
  validateGetRequest(twapsListQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.listTwaps({
          user: str(q.user),
          coin: str(q.coin),
          status: str(q.status),
          hours: num(q.hours),
          limit: num(q.limit),
          offset: num(q.offset),
          order: str(q.order),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_TWAPS_LIST_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:twap_id/fills',
  marketRateLimiter,
  validateGetRequest(twapsFillsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const twapId = String(req.params.twap_id);
      const { limit, offset, order } = req.query;
      res.json({
        success: true,
        data: await svc.getTwapFills(twapId, {
          limit: num(limit),
          offset: num(offset),
          order: str(order),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps/:twap_id/fills', {
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_TWAPS_FILLS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:twap_id',
  marketRateLimiter,
  validateGetRequest(twapsByIdParamsSchema),
  (async (req: Request, res: Response) => {
    try {
      sendIndexerHypeDexerSuccess(res, await svc.getTwap(String(req.params.twap_id)));
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps/:twap_id', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_TWAPS_BY_ID_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
