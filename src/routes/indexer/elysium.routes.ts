import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { addressLookupRateLimiter, marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  elysiumStatsQuerySchema,
  elysiumStatsDailyQuerySchema,
  elysiumBlocksQuerySchema,
  elysiumTransactionsQuerySchema,
  elysiumBatchesQuerySchema,
  elysiumBridgeTransfersQuerySchema,
  elysiumBridgeRetryablesQuerySchema,
  elysiumBridgeReservesQuerySchema,
  elysiumBridgeTokensQuerySchema,
  elysiumTokensQuerySchema,
  elysiumUserActivitySchema,
  elysiumUserBalancesSchema,
  elysiumUserBridgeSchema,
} from '../../schemas/indexer/elysium-indexer.schema';
import { IndexerElysiumService } from '../../services/indexer/indexer-elysium.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { sendUpstreamError } from '../../utils/upstream-error-response';

const router = Router();
const service = IndexerElysiumService.getInstance();

type QuerySchema = z.ZodObject<{ query: z.ZodTypeAny; params: z.ZodTypeAny }>;

/**
 * Registers a read-only Elysium pass-through route.
 * validateGetRequest rejects bad input with 400; the handler re-parses the
 * query to get coerced values (validateGetRequest does not mutate req.query).
 * Logs use a fixed message + fixed code only, never the path/query/error text,
 * to keep logDeduplicator keys low-cardinality.
 */
function register<S extends QuerySchema>(
  path: string,
  schema: S,
  code: string,
  handler: (query: z.infer<S['shape']['query']>, params: z.infer<S['shape']['params']>) => Promise<unknown>,
  extraLimiter?: RequestHandler
): void {
  const querySchema = schema.shape.query;
  const paramsSchema = schema.shape.params;
  router.get(
    path,
    marketRateLimiter,
    ...(extraLimiter ? [extraLimiter] : []),
    validateGetRequest(schema),
    (async (req: Request, res: Response) => {
      try {
        const query = querySchema.parse(req.query) as z.infer<S['shape']['query']>;
        const params = paramsSchema.parse(req.params) as z.infer<S['shape']['params']>;
        const data = await handler(query, params);
        res.json({ success: true, data });
      } catch (error) {
        logDeduplicator.error('GET /indexer/elysium upstream failure', {
          code,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        sendUpstreamError(res, error, 502, { success: false, error: 'Upstream error', code });
      }
    }) as RequestHandler
  );
}

register('/stats', elysiumStatsQuerySchema, 'INDEXER_ELYSIUM_STATS_ERROR', () => service.getStats());

register('/stats/daily', elysiumStatsDailyQuerySchema, 'INDEXER_ELYSIUM_STATS_DAILY_ERROR', (q) =>
  service.getStatsDaily(q)
);

register('/blocks', elysiumBlocksQuerySchema, 'INDEXER_ELYSIUM_BLOCKS_ERROR', (q) => service.getBlocks(q));

register('/transactions', elysiumTransactionsQuerySchema, 'INDEXER_ELYSIUM_TRANSACTIONS_ERROR', (q) =>
  service.getTransactions(q)
);

register('/batches', elysiumBatchesQuerySchema, 'INDEXER_ELYSIUM_BATCHES_ERROR', (q) => service.getBatches(q));

register(
  '/bridge/transfers',
  elysiumBridgeTransfersQuerySchema,
  'INDEXER_ELYSIUM_BRIDGE_TRANSFERS_ERROR',
  (q) => service.getBridgeTransfers(q)
);

register(
  '/bridge/retryables',
  elysiumBridgeRetryablesQuerySchema,
  'INDEXER_ELYSIUM_BRIDGE_RETRYABLES_ERROR',
  (q) => service.getBridgeRetryables(q)
);

register(
  '/bridge/reserves',
  elysiumBridgeReservesQuerySchema,
  'INDEXER_ELYSIUM_BRIDGE_RESERVES_ERROR',
  (q) => service.getBridgeReserves(q)
);

register('/bridge/tokens', elysiumBridgeTokensQuerySchema, 'INDEXER_ELYSIUM_BRIDGE_TOKENS_ERROR', (q) =>
  service.getBridgeTokens(q)
);

register('/tokens', elysiumTokensQuerySchema, 'INDEXER_ELYSIUM_TOKENS_ERROR', (q) => service.getTokens(q));

// Per-address pass-through: every address is a cache miss and a paid upstream
// call, so these share the tighter address-lookup limit.
register(
  '/user/:address/balances',
  elysiumUserBalancesSchema,
  'INDEXER_ELYSIUM_USER_BALANCES_ERROR',
  (_q, p) => service.getUserBalances(p.address),
  addressLookupRateLimiter
);

register(
  '/user/:address/activity',
  elysiumUserActivitySchema,
  'INDEXER_ELYSIUM_USER_ACTIVITY_ERROR',
  (q, p) => service.getUserActivity(p.address, q),
  addressLookupRateLimiter
);

register(
  '/user/:address/bridge',
  elysiumUserBridgeSchema,
  'INDEXER_ELYSIUM_USER_BRIDGE_ERROR',
  (q, p) => service.getUserBridge(p.address, q),
  addressLookupRateLimiter
);

export default router;
