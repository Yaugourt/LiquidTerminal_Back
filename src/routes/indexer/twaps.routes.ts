import { Router, Request, Response, RequestHandler } from 'express';
import {
  marketRateLimiter,
  passthroughRateLimiter,
  indexerAddressQueryRateLimiter,
  indexerAddressRateLimiter,
} from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  twapsListQuerySchema,
  twapsStatsQuerySchema,
  twapsUserQuerySchema,
  twapsByIdParamsSchema,
  twapsFillsQuerySchema,
} from '../../schemas/indexer/twaps.schema';
import { IndexerTwapsService } from '../../services/indexer/indexer-twaps.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { sendUpstreamError } from '../../utils/upstream-error-response';

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

/**
 * The front's TWAP source (last 24 h + still running): one shared aggregate,
 * so behind marketRateLimiter only: the caller picks no key, and the per-IP
 * passthrough budget is not spent on the front's poll. Registered before
 * '/:twap_id', which would take 'source' for an id. Nothing computed and
 * nothing kept is a temporary condition: 503, the front falls back.
 */
router.get(
  '/source',
  marketRateLimiter,
  (async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getTwapSource() });
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps/source', { error: e instanceof Error ? e.message : String(e) });
      sendUpstreamError(
        res,
        e,
        503,
        { success: false, error: 'TWAPs temporarily unavailable', code: 'INDEXER_TWAPS_SOURCE_UNAVAILABLE' },
        { 'Retry-After': '15' }
      );
    }
  }) as RequestHandler
);

/**
 * The deep rows of that source (older, slower-moving: ~90% of its bytes),
 * which the front reads once per walk, about a minute. Same limiter and 503
 * as '/source'.
 */
router.get(
  '/source/deep',
  marketRateLimiter,
  (async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getTwapSourceDeep() });
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps/source/deep', { error: e instanceof Error ? e.message : String(e) });
      sendUpstreamError(
        res,
        e,
        503,
        { success: false, error: 'TWAPs temporarily unavailable', code: 'INDEXER_TWAPS_SOURCE_DEEP_UNAVAILABLE' },
        { 'Retry-After': '15' }
      );
    }
  }) as RequestHandler
);

router.get(
  '/stats',
  marketRateLimiter,
  passthroughRateLimiter,
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
      sendUpstreamError(res, e, 502, {
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
  passthroughRateLimiter,
  indexerAddressRateLimiter,
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
      sendUpstreamError(res, e, 502, {
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
  passthroughRateLimiter,
  indexerAddressQueryRateLimiter,
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
      sendUpstreamError(res, e, 502, {
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
  passthroughRateLimiter,
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
      sendUpstreamError(res, e, 502, {
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
  passthroughRateLimiter,
  validateGetRequest(twapsByIdParamsSchema),
  (async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getTwap(String(req.params.twap_id)) });
    } catch (e) {
      logDeduplicator.error('GET /indexer/twaps/:twap_id', { error: e instanceof Error ? e.message : String(e) });
      sendUpstreamError(res, e, 502, {
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_TWAPS_BY_ID_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
