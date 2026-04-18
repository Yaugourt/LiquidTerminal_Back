import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerBuildersListQuerySchema,
  indexerBuildersStatsQuerySchema,
  indexerBuildersStatsAllTimeframesQuerySchema,
  indexerBuildersTopQuerySchema,
  indexerBuilderAddressStatsQuerySchema,
  indexerBuilderAddressUsersQuerySchema,
} from '../../schemas/indexer/builders-indexer.schema';
import { IndexerBuildersIndexerService } from '../../services/indexer/indexer-builders-indexer.service';
import type { IndexerBuildersTimeframe } from '../../clients/hypedexer/rest/builders/builders-indexer.client';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { sendIndexerHypeDexerSuccess } from '../../utils/indexer-hypedexer-response.util';

const router = Router();
const service = IndexerBuildersIndexerService.getInstance();

function parseTimeframe(v: unknown): IndexerBuildersTimeframe | undefined {
  if (v !== '1h' && v !== '24h' && v !== '7d' && v !== '30d') return undefined;
  return v;
}

router.get(
  '/list',
  marketRateLimiter,
  validateGetRequest(indexerBuildersListQuerySchema),
  (async (_req: Request, res: Response) => {
    try {
      const upstream = await service.listBuilders();
      sendIndexerHypeDexerSuccess(res, upstream);
    } catch (error) {
      logDeduplicator.error('GET /indexer/builders/list', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_BUILDERS_LIST_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/stats/all-timeframes',
  marketRateLimiter,
  validateGetRequest(indexerBuildersStatsAllTimeframesQuerySchema),
  (async (_req: Request, res: Response) => {
    try {
      const upstream = await service.getStatsAllTimeframes();
      sendIndexerHypeDexerSuccess(res, upstream);
    } catch (error) {
      logDeduplicator.error('GET /indexer/builders/stats/all-timeframes', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_BUILDERS_STATS_ALL_TF_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/stats',
  marketRateLimiter,
  validateGetRequest(indexerBuildersStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const data = await service.getGlobalStats(parseTimeframe(req.query.timeframe));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/builders/stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_BUILDERS_STATS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/top',
  marketRateLimiter,
  validateGetRequest(indexerBuildersTopQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { timeframe, sort, limit } = req.query;
      const upstream = await service.getTopBuilders({
        timeframe: parseTimeframe(timeframe),
        sort: typeof sort === 'string' ? sort : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      });
      sendIndexerHypeDexerSuccess(res, upstream);
    } catch (error) {
      logDeduplicator.error('GET /indexer/builders/top', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_BUILDERS_TOP_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:builder_address/stats',
  marketRateLimiter,
  validateGetRequest(indexerBuilderAddressStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const builderAddress = String(req.params.builder_address);
      const upstream = await service.getBuilderStats(builderAddress, {
        timeframe: parseTimeframe(req.query.timeframe),
      });
      sendIndexerHypeDexerSuccess(res, upstream);
    } catch (error) {
      logDeduplicator.error('GET /indexer/builders/:address/stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_BUILDER_DETAIL_STATS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/:builder_address/users',
  marketRateLimiter,
  validateGetRequest(indexerBuilderAddressUsersQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const builderAddress = String(req.params.builder_address);
      const { timeframe, limit } = req.query;
      const upstream = await service.getBuilderUsers(builderAddress, {
        timeframe: parseTimeframe(timeframe),
        limit: limit !== undefined ? Number(limit) : undefined,
      });
      sendIndexerHypeDexerSuccess(res, upstream);
    } catch (error) {
      logDeduplicator.error('GET /indexer/builders/:address/users', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_BUILDER_USERS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
