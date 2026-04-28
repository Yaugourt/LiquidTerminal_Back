import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  evmStatsQuerySchema,
  evmStatsDailyQuerySchema,
  evmBlocksQuerySchema,
  evmTransactionsQuerySchema,
  evmBridgeEventsQuerySchema,
  evmLedgerTransfersQuerySchema,
} from '../../schemas/indexer/evm-indexer.schema';
import { IndexerEvmService } from '../../services/indexer/indexer-evm.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = IndexerEvmService.getInstance();

function wrap(handler: () => Promise<unknown>, label: string, errorCode: string): RequestHandler {
  return (async (_req, res: Response) => {
    try {
      const data = await handler();
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error(label, { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: errorCode,
      });
    }
  }) as RequestHandler;
}

router.get(
  '/stats',
  marketRateLimiter,
  validateGetRequest(evmStatsQuerySchema),
  wrap(() => service.getEvmStats(), 'GET /indexer/evm/stats', 'INDEXER_EVM_STATS_ERROR')
);

router.get(
  '/stats/daily',
  marketRateLimiter,
  validateGetRequest(evmStatsDailyQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
      const data = await service.getEvmStatsDaily(days);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/evm/stats/daily', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_EVM_STATS_DAILY_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/blocks',
  marketRateLimiter,
  validateGetRequest(evmBlocksQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { limit, start_time, end_time } = req.query as Record<string, string | undefined>;
      const params = {
        limit: limit !== undefined ? Number(limit) : undefined,
        start_time: start_time !== undefined ? Number(start_time) : undefined,
        end_time: end_time !== undefined ? Number(end_time) : undefined,
      };
      const data = await service.getEvmBlocks(params);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/evm/blocks', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_EVM_BLOCKS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/transactions',
  marketRateLimiter,
  validateGetRequest(evmTransactionsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { limit, block_number, to_addr, start_time, end_time } = req.query as Record<
        string,
        string | undefined
      >;
      const params = {
        limit: limit !== undefined ? Number(limit) : undefined,
        block_number: block_number !== undefined ? Number(block_number) : undefined,
        to_addr,
        start_time: start_time !== undefined ? Number(start_time) : undefined,
        end_time: end_time !== undefined ? Number(end_time) : undefined,
      };
      const data = await service.getEvmTransactions(params);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/evm/transactions', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_EVM_TRANSACTIONS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/bridge/events',
  marketRateLimiter,
  validateGetRequest(evmBridgeEventsQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { limit, start_time, end_time } = req.query as Record<string, string | undefined>;
      const params = {
        limit: limit !== undefined ? Number(limit) : undefined,
        start_time: start_time !== undefined ? Number(start_time) : undefined,
        end_time: end_time !== undefined ? Number(end_time) : undefined,
      };
      const data = await service.getEvmBridgeEvents(params);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/evm/bridge/events', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_EVM_BRIDGE_EVENTS_ERROR',
      });
    }
  }) as RequestHandler
);

router.get(
  '/ledger/transfers',
  marketRateLimiter,
  validateGetRequest(evmLedgerTransfersQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const { limit, start_time, end_time } = req.query as Record<string, string | undefined>;
      const params = {
        limit: limit !== undefined ? Number(limit) : undefined,
        start_time: start_time !== undefined ? Number(start_time) : undefined,
        end_time: end_time !== undefined ? Number(end_time) : undefined,
      };
      const data = await service.getEvmLedgerTransfers(params);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('GET /indexer/evm/ledger/transfers', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'INDEXER_EVM_LEDGER_TRANSFERS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
