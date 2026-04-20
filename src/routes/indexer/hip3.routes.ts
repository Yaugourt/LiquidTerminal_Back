import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  hip3AssetsQuerySchema,
  hip3AssetTickerParamsSchema,
  hip3DexsQuerySchema,
  hip3DexIdParamsSchema,
  hip3OverviewSchema,
  hip3PriorityFeesGossipStatusSchema,
  hip3PriorityFeesGossipHistoryQuerySchema,
  hip3AuctionsQuerySchema,
  hip3AuctionCurrentSchema,
  hip3AuctionsHistoryQuerySchema,
  hip3FillsQuerySchema,
  hip3LeaderboardQuerySchema,
  hip3OhlcvQuerySchema,
  hip3OracleStatsQuerySchema,
  hip3SnapshotsQuerySchema,
  hip3StatsTradersQuerySchema,
  hip3TopMoversQuerySchema,
  hip3UserCoinsSchema,
  hip3UserFillsSchema,
  hip3UserOverviewSchema,
} from '../../schemas/indexer/hip3.schema';
import { IndexerHip3Service } from '../../services/indexer/indexer-hip3.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const svc = IndexerHip3Service.getInstance();

function str(q: unknown): string | undefined {
  return typeof q === 'string' ? q : undefined;
}

function num(q: unknown): number | undefined {
  if (q === undefined || q === '') return undefined;
  const n = Number(q);
  return Number.isFinite(n) ? n : undefined;
}

function send502(res: Response, code: string, error: unknown): void {
  logDeduplicator.error(`HIP3 ${code}`, { error: error instanceof Error ? error.message : String(error) });
  res.status(502).json({
    success: false,
    error: error instanceof Error ? error.message : 'Upstream error',
    code,
  });
}

router.get(
  '/overview',
  marketRateLimiter,
  validateGetRequest(hip3OverviewSchema),
  (async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getOverview() });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_OVERVIEW_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/priority-fees/gossip/status',
  marketRateLimiter,
  validateGetRequest(hip3PriorityFeesGossipStatusSchema),
  (async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getPriorityFeesGossipStatus() });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_PRIORITY_FEES_GOSSIP_STATUS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/priority-fees/gossip/history',
  marketRateLimiter,
  validateGetRequest(hip3PriorityFeesGossipHistoryQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const data = await svc.getPriorityFeesGossipHistory({
        slot_id: num(q.slot_id),
        start_time: str(q.start_time),
        end_time: str(q.end_time),
        offset: num(q.offset),
        limit: num(q.limit),
        order: str(q.order),
      });
      res.json({ success: true, data: { rows: Array.isArray(data) ? data : [], total_count: null } });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_PRIORITY_FEES_GOSSIP_HISTORY_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/assets',
  marketRateLimiter,
  validateGetRequest(hip3AssetsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { dex_id, search, limit, offset } = req.query;
      res.json({
        success: true,
        data: await svc.getAssets({
          dex_id: str(dex_id),
          search: str(search),
          limit: num(limit),
          offset: num(offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_ASSETS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/assets/:ticker',
  marketRateLimiter,
  validateGetRequest(hip3AssetTickerParamsSchema),
  (async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getAssetByTicker(String(req.params.ticker)) });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_ASSET_TICKER_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/dexs',
  marketRateLimiter,
  validateGetRequest(hip3DexsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { limit, offset } = req.query;
      res.json({ success: true, data: await svc.getDexs({ limit: num(limit), offset: num(offset) }) });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_DEXS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/dexs/:dex_id',
  marketRateLimiter,
  validateGetRequest(hip3DexIdParamsSchema),
  (async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getDexById(String(req.params.dex_id)) });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_DEX_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/auctions/current',
  marketRateLimiter,
  validateGetRequest(hip3AuctionCurrentSchema),
  (async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getAuctionCurrent() });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_AUCTION_CURRENT_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/auctions/history',
  marketRateLimiter,
  validateGetRequest(hip3AuctionsHistoryQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { dex_id, limit, offset } = req.query;
      res.json({
        success: true,
        data: await svc.getAuctionsHistory({
          dex_id: str(dex_id),
          limit: num(limit),
          offset: num(offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_AUCTIONS_HISTORY_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/auctions',
  marketRateLimiter,
  validateGetRequest(hip3AuctionsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { status, limit, offset } = req.query;
      res.json({
        success: true,
        data: await svc.getAuctions({
          status: str(status),
          limit: num(limit),
          offset: num(offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_AUCTIONS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/fills',
  marketRateLimiter,
  validateGetRequest(hip3FillsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getFills({
          dex_id: str(q.dex_id),
          coin: str(q.coin),
          user: str(q.user),
          side: str(q.side),
          start: str(q.start),
          end: str(q.end),
          min_notional: num(q.min_notional),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_FILLS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/leaderboard',
  marketRateLimiter,
  validateGetRequest(hip3LeaderboardQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { by, dex_id, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getLeaderboard({
          by: str(by),
          dex_id: str(dex_id),
          limit: num(limit),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_LEADERBOARD_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/ohlcv',
  marketRateLimiter,
  validateGetRequest(hip3OhlcvQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { coin, dex_id, start, end, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getOhlcv({
          coin: str(coin) as string,
          dex_id: str(dex_id),
          start: str(start),
          end: str(end),
          limit: num(limit),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_OHLCV_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/oracle/stats',
  marketRateLimiter,
  validateGetRequest(hip3OracleStatsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { dex_id, asset_id, start, end, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getOracleStats({
          dex_id: str(dex_id) as string,
          asset_id: str(asset_id),
          start: str(start),
          end: str(end),
          limit: num(limit),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_ORACLE_STATS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/snapshots',
  marketRateLimiter,
  validateGetRequest(hip3SnapshotsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { dex_id, coin } = req.query;
      res.json({ success: true, data: await svc.getSnapshots({ dex_id: str(dex_id), coin: str(coin) }) });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_SNAPSHOTS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/stats/traders',
  marketRateLimiter,
  validateGetRequest(hip3StatsTradersQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { dex_id, coin, limit, offset } = req.query;
      res.json({
        success: true,
        data: await svc.getStatsTraders({
          dex_id: str(dex_id),
          coin: str(coin),
          limit: num(limit),
          offset: num(offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_STATS_TRADERS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/top-movers',
  marketRateLimiter,
  validateGetRequest(hip3TopMoversQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getTopMovers({ limit: num(req.query.limit) }) });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_TOP_MOVERS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/users/:address/coins',
  marketRateLimiter,
  validateGetRequest(hip3UserCoinsSchema),
  (async (req: Request, res: Response) => {
    try {
      const address = String(req.params.address);
      res.json({ success: true, data: await svc.getUserCoins(address, { limit: num(req.query.limit) }) });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_USER_COINS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/users/:address/fills',
  marketRateLimiter,
  validateGetRequest(hip3UserFillsSchema),
  (async (req: Request, res: Response) => {
    try {
      const address = String(req.params.address);
      const q = req.query;
      res.json({
        success: true,
        data: await svc.getUserFills(address, {
          coin: str(q.coin),
          dex_id: str(q.dex_id),
          start: str(q.start),
          end: str(q.end),
          limit: num(q.limit),
          offset: num(q.offset),
        }),
      });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_USER_FILLS_ERROR', e);
    }
  }) as RequestHandler
);

router.get(
  '/users/:address/overview',
  marketRateLimiter,
  validateGetRequest(hip3UserOverviewSchema),
  (async (req: Request, res: Response) => {
    try {
      res.json({ success: true, data: await svc.getUserOverview(String(req.params.address)) });
    } catch (e) {
      send502(res, 'INDEXER_HIP3_USER_OVERVIEW_ERROR', e);
    }
  }) as RequestHandler
);

export default router;
