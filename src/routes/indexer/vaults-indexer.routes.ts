import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  vaultsDetailsQuerySchema,
  vaultsSummariesQuerySchema,
  vaultsUserEquitiesQuerySchema,
  vaultsDailySnapshotsQuerySchema,
  vaultsEquitySnapshotsQuerySchema,
  vaultsLedgerQuerySchema,
  vaultsLeaderboardFollowersQuerySchema,
  vaultsLeaderboardOutflowsQuerySchema,
} from '../../schemas/indexer/vaults-indexer.schema';
import {
  IndexerVaultsIndexerService,
  LeaderboardWindow,
} from '../../services/indexer/indexer-vaults-indexer.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const svc = IndexerVaultsIndexerService.getInstance();

function num(q: unknown): number | undefined {
  if (q === undefined || q === '') return undefined;
  const n = Number(q);
  return Number.isFinite(n) ? n : undefined;
}

function str(q: unknown): string | undefined {
  return typeof q === 'string' ? q : undefined;
}

router.get(
  '/vaultDetails',
  marketRateLimiter,
  validateGetRequest(vaultsDetailsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { vaultAddress, startTime, endTime, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getVaultDetails({
          vaultAddress: vaultAddress as string,
          startTime: str(startTime),
          endTime: str(endTime),
          limit: num(limit),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/vaultDetails', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_DETAILS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/vaultSummaries',
  marketRateLimiter,
  validateGetRequest(vaultsSummariesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { includeClosed, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getVaultSummaries({
          includeClosed:
            includeClosed === 'true' ||
            includeClosed === '1' ||
            (Array.isArray(includeClosed) && includeClosed[0] === 'true'),
          limit: num(limit),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/vaultSummaries', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_SUMMARIES_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/userVaultEquities',
  marketRateLimiter,
  validateGetRequest(vaultsUserEquitiesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { user, startTime, endTime, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getUserVaultEquities({
          user: user as string,
          startTime: str(startTime),
          endTime: str(endTime),
          limit: num(limit),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/userVaultEquities', {
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_USER_EQUITIES_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/dailySnapshots',
  marketRateLimiter,
  validateGetRequest(vaultsDailySnapshotsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { vaultAddress, startTime, endTime, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getDailySnapshots({
          vaultAddress: vaultAddress as string,
          startTime: str(startTime),
          endTime: str(endTime),
          limit: num(limit),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/dailySnapshots', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_DAILY_SNAPSHOTS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/equitySnapshots',
  marketRateLimiter,
  validateGetRequest(vaultsEquitySnapshotsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { vaultAddress, startTime, endTime, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getEquitySnapshots({
          vaultAddress: vaultAddress as string,
          startTime: str(startTime),
          endTime: str(endTime),
          limit: num(limit),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/equitySnapshots', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_EQUITY_SNAPSHOTS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/vaultLedger',
  marketRateLimiter,
  validateGetRequest(vaultsLedgerQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { vaultAddress, user, startTime, endTime, limit } = req.query;
      res.json({
        success: true,
        data: await svc.getVaultLedger({
          vaultAddress: vaultAddress as string,
          user: str(user),
          startTime: str(startTime),
          endTime: str(endTime),
          limit: num(limit),
        }),
      });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/vaultLedger', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_LEDGER_ERROR',
      });
    }
  }) as RequestHandler
);

function parseWindow(q: unknown): LeaderboardWindow {
  return q === '7d' ? '7d' : '24h';
}

router.get(
  '/leaderboards/followers-gained',
  marketRateLimiter,
  validateGetRequest(vaultsLeaderboardFollowersQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const window = parseWindow(req.query.window);
      const limit = num(req.query.limit) ?? 5;
      const { data, meta } = await svc.getFollowersGained(window, limit);
      res.json({ success: true, data, meta });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/leaderboards/followers-gained', {
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_LEADERBOARDS_FOLLOWERS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/leaderboards/outflows',
  marketRateLimiter,
  validateGetRequest(vaultsLeaderboardOutflowsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const window = parseWindow(req.query.window);
      const limit = num(req.query.limit) ?? 3;
      const { data, meta } = await svc.getOutflows(window, limit);
      res.json({ success: true, data, meta });
    } catch (e) {
      logDeduplicator.error('GET /indexer/vaults/leaderboards/outflows', {
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(502).json({
        success: false,
        error: e instanceof Error ? e.message : 'Upstream error',
        code: 'INDEXER_VAULTS_LEADERBOARDS_OUTFLOWS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
