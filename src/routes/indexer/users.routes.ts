import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerUsersLeaderboardQuerySchema,
  indexerUsersCoinsQuerySchema,
  indexerUsersOverviewQuerySchema,
  indexerUsersPerformanceQuerySchema,
} from '../../schemas/indexer/users-indexer.schema';
import { IndexerUsersService } from '../../services/indexer/indexer-users.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = IndexerUsersService.getInstance();

router.get(
  '/leaderboard',
  marketRateLimiter,
  validateGetRequest(indexerUsersLeaderboardQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const upstream = await service.getLeaderboard({
        by: (q.by as 'volume' | 'pnl' | 'trades' | 'priority_fees') ?? 'volume',
        hours: q.hours !== undefined ? Number(q.hours) : 24,
        limit: q.limit !== undefined ? Number(q.limit) : 20,
      });
      res.json({ success: true, data: upstream });
    } catch (error) {
      logDeduplicator.error('GET /indexer/users/leaderboard', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_USERS_LEADERBOARD_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:user/coins',
  marketRateLimiter,
  validateGetRequest(indexerUsersCoinsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const user = String(req.params.user);
      const { start_time, end_time, limit } = req.query;
      const data = await service.getUserCoins(user, {
        start_time: typeof start_time === 'string' ? start_time : undefined,
        end_time: typeof end_time === 'string' ? end_time : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/users/:user/coins', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_USERS_COINS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:user/overview',
  marketRateLimiter,
  validateGetRequest(indexerUsersOverviewQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const user = String(req.params.user);
      const { start_time, end_time } = req.query;
      const data = await service.getUserOverview(user, {
        start_time: typeof start_time === 'string' ? start_time : undefined,
        end_time: typeof end_time === 'string' ? end_time : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/users/:user/overview', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_USERS_OVERVIEW_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:user/performance',
  marketRateLimiter,
  validateGetRequest(indexerUsersPerformanceQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const user = String(req.params.user);
      const { start_time, end_time } = req.query;
      const data = await service.getUserPerformance(user, {
        start_time: typeof start_time === 'string' ? start_time : undefined,
        end_time: typeof end_time === 'string' ? end_time : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/users/:user/performance', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_USERS_PERFORMANCE_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
