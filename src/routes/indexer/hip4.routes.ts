import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter, passthroughRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  hip4FillsQuerySchema,
  hip4SettlementsQuerySchema,
  hip4MarketsEnrichedQuerySchema,
  hip4QuestionsWithOutcomesQuerySchema,
  hip4AnalyticsQuerySchema,
} from '../../schemas/indexer/hip4.schema';
import { IndexerHip4Service } from '../../services/indexer/indexer-hip4.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { sendUpstreamError } from '../../utils/upstream-error-response';

const router = Router();
const svc = IndexerHip4Service.getInstance();

function str(q: unknown): string | undefined {
  return typeof q === 'string' ? q : undefined;
}

function num(q: unknown): number | undefined {
  if (q === undefined || q === '') return undefined;
  const n = Number(q);
  return Number.isFinite(n) ? n : undefined;
}

function send502(res: Response, code: string, error: unknown): void {
  logDeduplicator.error(`HIP4 ${code}`, { error: error instanceof Error ? error.message : String(error) });
  sendUpstreamError(res, error, 502, {
    success: false,
    error: 'Upstream error',
    code,
  });
}

/** Nothing computed and nothing kept: a temporary condition, the client retries. */
function send503(res: Response, code: string, error: unknown, what: string): void {
  logDeduplicator.error(`HIP4 ${code}`, { error: error instanceof Error ? error.message : String(error) });
  sendUpstreamError(
    res,
    error,
    503,
    { success: false, error: `HIP-4 ${what} temporarily unavailable`, code },
    { 'Retry-After': '15' }
  );
}

router.get(
  '/fills',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(hip4FillsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getFills({
          user: str(q.user),
          coin: str(q.coin),
          outcome_id: num(q.outcome_id),
          start: str(q.start),
          end: str(q.end),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_FILLS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/settlements',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(hip4SettlementsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getSettlements({
          outcome_id: num(q.outcome_id),
          start: str(q.start),
          end: str(q.end),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_SETTLEMENTS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/markets-enriched',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(hip4MarketsEnrichedQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getMarketsEnriched({
          class: str(q.class),
          underlying: str(q.underlying),
          question_id: num(q.question_id),
          outcome_id: num(q.outcome_id),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_MARKETS_ENRICHED_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/questions-with-outcomes',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(hip4QuestionsWithOutcomesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getQuestionsWithOutcomes({
          question_id: num(q.question_id),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_QUESTIONS_WITH_OUTCOMES_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/analytics',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(hip4AnalyticsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getAnalytics({
          interval: str(q.interval),
          coin: str(q.coin),
          outcome_id: num(q.outcome_id),
          start: str(q.start),
          end: str(q.end),
          limit: num(q.limit),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_ANALYTICS_ERROR', e);
    }
  }) as RequestHandler
);

/**
 * Every live outcome side's volume, one shared entry. Behind marketRateLimiter
 * only: the caller picks no cache key, so the per-IP passthrough budget (which
 * guards callers that do) is not spent on the HIP-4 pages' poll.
 */
router.get(
  '/live-volumes',
  marketRateLimiter,
  (async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getLiveVolumes() });
    } catch (e) {
      send503(res, 'INDEXER_HIP4_LIVE_VOLUMES_UNAVAILABLE', e, 'volumes');
    }
  }) as RequestHandler
);

/**
 * How the markets that no longer trade ended, one shared entry: no params,
 * so behind marketRateLimiter only, like live-volumes.
 */
router.get(
  '/resolutions',
  marketRateLimiter,
  (async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getResolutions() });
    } catch (e) {
      send503(res, 'INDEXER_HIP4_RESOLUTIONS_UNAVAILABLE', e, 'resolutions');
    }
  }) as RequestHandler
);

export default router;
