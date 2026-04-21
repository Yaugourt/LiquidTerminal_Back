import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  hip4FillsQuerySchema,
  hip4FeesQuerySchema,
  hip4MarketsQuerySchema,
  hip4OutcomesQuerySchema,
  hip4QuestionsQuerySchema,
  hip4SettlementsQuerySchema,
  hip4OutcomeTokensQuerySchema,
  hip4FeeScalesQuerySchema,
  hip4UserActionsQuerySchema,
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
    error: error instanceof Error ? error.message : 'Upstream error',
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
  '/fees',
  marketRateLimiter,
  validateGetRequest(hip4FeesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getFees({
          user: str(q.user),
          coin: str(q.coin),
          start: str(q.start),
          end: str(q.end),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_FEES_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/markets',
  marketRateLimiter,
  validateGetRequest(hip4MarketsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getMarkets({
          outcome_id: num(q.outcome_id),
          class: str(q.class),
          underlying: str(q.underlying),
          question_id: num(q.question_id),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_MARKETS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/outcomes',
  marketRateLimiter,
  validateGetRequest(hip4OutcomesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getOutcomes({
          outcome_id: num(q.outcome_id),
          class: str(q.class),
          underlying: str(q.underlying),
          question_id: num(q.question_id),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_OUTCOMES_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/questions',
  marketRateLimiter,
  validateGetRequest(hip4QuestionsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getQuestions({
          question_id: num(q.question_id),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_QUESTIONS_ERROR', e);
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
  '/outcome-tokens',
  marketRateLimiter,
  validateGetRequest(hip4OutcomeTokensQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getOutcomeTokens({
          outcome_id: num(q.outcome_id),
          coin: str(q.coin),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_OUTCOME_TOKENS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/fee-scales',
  marketRateLimiter,
  validateGetRequest(hip4FeeScalesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getFeeScales({
          start: str(q.start),
          end: str(q.end),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_FEE_SCALES_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/user-actions',
  marketRateLimiter,
  validateGetRequest(hip4UserActionsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getUserActions({
          user: str(q.user),
          action_type: str(q.action_type),
          outcome_id: num(q.outcome_id),
          start: str(q.start),
          end: str(q.end),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP4_USER_ACTIONS_ERROR', e);
    }
  }) as RequestHandler
);

export default router;
