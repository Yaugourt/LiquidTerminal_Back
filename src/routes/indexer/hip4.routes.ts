import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
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
  res.status(502).json({
    success: false,
    error: 'Upstream error',
    code,
  });
}

router.get(
  '/fills',
  marketRateLimiter,
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

export default router;
