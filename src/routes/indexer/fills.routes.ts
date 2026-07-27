import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter, passthroughRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  indexerFillsQuerySchema,
  indexerFillsCountQuerySchema,
  indexerFillsUserAddressQuerySchema,
  indexerFillsSpotQuerySchema,
  indexerFillsSpotUserQuerySchema,
} from '../../schemas/indexer/fills.schema';
import { IndexerFillsService } from '../../services/indexer/indexer-fills.service';
import {
  IndexerFillsQuery,
  IndexerFillsSpotQuery,
  IndexerFillsUserByAddressQuery,
} from '../../clients/hypedexer/rest/fills/fills.client';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = IndexerFillsService.getInstance();

function optionalQueryBoolean(query: Request['query'], key: string): boolean | undefined {
  const v = query[key];
  if (v === undefined || v === '') return undefined;
  if (Array.isArray(v)) return optionalQueryBoolean({ [key]: v[0] } as Request['query'], key);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

function queryToParams(query: Request['query']): IndexerFillsQuery {
  const params: IndexerFillsQuery = {};
  if (typeof query.user === 'string') params.user = query.user;
  if (typeof query.coin === 'string') params.coin = query.coin;
  if (typeof query.side === 'string') params.side = query.side;
  if (query.size_usd !== undefined) params.size_usd = Number(query.size_usd);
  if (typeof query.start_time === 'string') params.start_time = query.start_time;
  if (typeof query.end_time === 'string') params.end_time = query.end_time;
  if (query.offset !== undefined) params.offset = Number(query.offset);
  if (query.limit !== undefined) params.limit = Number(query.limit);
  if (typeof query.cursor === 'string') params.cursor = query.cursor;
  if (typeof query.order === 'string') params.order = query.order;
  const hpg = optionalQueryBoolean(query, 'has_priority_gas');
  if (hpg !== undefined) params.has_priority_gas = hpg;
  return params;
}

function userFillsQuery(query: Request['query']): IndexerFillsUserByAddressQuery {
  const params: IndexerFillsUserByAddressQuery = {};
  if (typeof query.time_range === 'string') params.time_range = query.time_range;
  if (typeof query.coin === 'string') params.coin = query.coin;
  if (query.offset !== undefined) params.offset = Number(query.offset);
  if (query.limit !== undefined) params.limit = Number(query.limit);
  if (typeof query.cursor === 'string') params.cursor = query.cursor;
  if (typeof query.order === 'string') params.order = query.order;
  const hpgU = optionalQueryBoolean(query, 'has_priority_gas');
  if (hpgU !== undefined) params.has_priority_gas = hpgU;
  return params;
}

function spotQueryToParams(query: Request['query']): IndexerFillsSpotQuery {
  const params: IndexerFillsSpotQuery = {};
  if (typeof query.user === 'string') params.user = query.user;
  if (typeof query.coin === 'string') params.coin = query.coin;
  if (typeof query.coins === 'string') params.coins = query.coins;
  if (typeof query.side === 'string') params.side = query.side;
  if (typeof query.start_time === 'string') params.start_time = query.start_time;
  if (typeof query.end_time === 'string') params.end_time = query.end_time;
  if (query.offset !== undefined) params.offset = Number(query.offset);
  if (query.limit !== undefined) params.limit = Number(query.limit);
  if (typeof query.order === 'string') params.order = query.order;
  const hpgS = optionalQueryBoolean(query, 'has_priority_gas');
  if (hpgS !== undefined) params.has_priority_gas = hpgS;
  return params;
}

router.get(
  '/recent',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(indexerFillsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const data = await service.getFillsRecent(queryToParams(req.query));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/fills/recent', { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_FILLS_RECENT_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/count',
  marketRateLimiter,
  validateGetRequest(indexerFillsCountQuerySchema),
  (async (_req: Request, res: Response) => {
    try {
      const data = await service.getFillsCount();
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/fills/count', { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_FILLS_COUNT_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/spot/user/:user_address',
  marketRateLimiter,
  validateGetRequest(indexerFillsSpotUserQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const userAddress = String(req.params.user_address);
      const data = await service.getSpotUserFills(userAddress, spotQueryToParams(req.query));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/fills/spot/user/:user_address', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_FILLS_SPOT_USER_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/spot',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(indexerFillsSpotQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const data = await service.getSpotFills(spotQueryToParams(req.query));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/fills/spot', { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_FILLS_SPOT_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/user/:user_address',
  marketRateLimiter,
  validateGetRequest(indexerFillsUserAddressQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const userAddress = String(req.params.user_address);
      const data = await service.getUserFills(userAddress, userFillsQuery(req.query));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/fills/user/:user_address', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_FILLS_USER_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(indexerFillsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const data = await service.getFills(queryToParams(req.query));
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/fills', { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'INDEXER_FILLS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
