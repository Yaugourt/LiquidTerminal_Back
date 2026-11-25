import { Router, Request, Response, RequestHandler } from 'express';
import {
  marketRateLimiter,
  passthroughRateLimiter,
  indexerAddressRateLimiter,
} from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerUsersLeaderboardQuerySchema,
  indexerUsersCoinsQuerySchema,
  indexerUsersOverviewQuerySchema,
  indexerUsersPerformanceQuerySchema,
} from '../../schemas/indexer/users-indexer.schema';
import { MAX_INDEXER_OFFSET } from '../../schemas/indexer/bounds';
import type { LeaderboardMetric, LeaderboardWindow } from '../../constants/indexer-leaderboard.constants';
import { IndexerUsersService } from '../../services/indexer/indexer-users.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { sendUpstreamError } from '../../utils/upstream-error-response';

const router = Router();
const service = IndexerUsersService.getInstance();

/** `total` is how many addresses are ranked; the pages announced are the ones this route serves. */
function leaderboardPagination(total: number | null, page: number, limit: number, rows: number) {
  const totalPages =
    total === null ? null : Math.min(Math.ceil(total / limit), Math.floor(MAX_INDEXER_OFFSET / limit) + 1);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: totalPages === null ? rows === limit : page < totalPages,
    hasPrevious: page > 1,
  };
}

router.get(
  '/leaderboard',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(indexerUsersLeaderboardQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const limit = q.limit !== undefined ? Number(q.limit) : 20;
      if (q.window !== undefined) {
        const page = q.page !== undefined ? Number(q.page) : 1;
        const { rows, total } = await service.getLeaderboardWindow({
          window: q.window as LeaderboardWindow,
          by: (q.by as LeaderboardMetric) ?? 'volume',
          page,
          limit,
        });
        res.json({ success: true, data: rows, pagination: leaderboardPagination(total, page, limit, rows.length) });
        return;
      }
      const upstream = await service.getLeaderboard({
        by: (q.by as 'volume' | 'pnl' | 'trades' | 'priority_fees') ?? 'volume',
        hours: q.hours !== undefined ? Number(q.hours) : 24,
        limit,
      });
      res.json({ success: true, data: upstream });
    } catch (error) {
      logDeduplicator.error('GET /indexer/users/leaderboard', {
        error: error instanceof Error ? error.message : String(error),
      });
      sendUpstreamError(res, error, 502, {
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
  passthroughRateLimiter,
  indexerAddressRateLimiter,
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
      sendUpstreamError(res, error, 502, {
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
  passthroughRateLimiter,
  indexerAddressRateLimiter,
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
      sendUpstreamError(res, error, 502, {
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
  passthroughRateLimiter,
  indexerAddressRateLimiter,
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
      sendUpstreamError(res, error, 502, {
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_USERS_PERFORMANCE_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
