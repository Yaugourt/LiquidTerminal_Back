import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { addressLookupRateLimiter, elysiumSearchRateLimiter, marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  elysiumAnalyticsAddressSchema,
  elysiumAnalyticsContractsSchema,
  elysiumAnalyticsMethodsSchema,
  elysiumAnalyticsDaysSchema,
  elysiumAnalyticsFeesSchema,
  elysiumAnalyticsLaunchpadsSchema,
  elysiumAnalyticsStatusSchema,
  LAUNCHPAD_SEARCH_MIN_CHARS,
} from '../../schemas/elysium-analytics.schema';
import { ElysiumAnalyticsService } from '../../services/elysium/elysium-analytics.service';
import { ElysiumEcosystemService } from '../../services/elysium/elysium-ecosystem.service';
import {
  ElysiumLaunchpadMarketService,
  LaunchpadBusyError,
  LaunchpadSearchBusyError,
} from '../../services/elysium/elysium-launchpad-market.service';
import { rateLimitKeyForIp } from '../../utils/client-ip';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { sendUpstreamError } from '../../utils/upstream-error-response';

const router = Router();
const service = ElysiumAnalyticsService.getInstance();
const ecosystem = ElysiumEcosystemService.getInstance();
const launchpadMarket = ElysiumLaunchpadMarketService.getInstance();

type QuerySchema = z.ZodObject<{ query: z.ZodTypeAny; params: z.ZodTypeAny }>;

/** Prisma / driver failures mean the historical DB is unavailable (503). */
function isDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name.startsWith('PrismaClient') || error.name === 'DriverAdapterError';
}

/**
 * Registers a read-only analytics route. The handler re-parses the query to
 * get coerced values and defaults (validateGetRequest does not mutate
 * req.query). Logs carry a fixed message + fixed code only. The handler also
 * gets the client's key (IP, or /64), for the reads that keep a share per client.
 */
function register<S extends QuerySchema>(
  path: string,
  schema: S,
  code: string,
  handler: (query: z.infer<S['shape']['query']>, params: z.infer<S['shape']['params']>, client: string) => Promise<unknown>,
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
        const data = await handler(query, params, rateLimitKeyForIp(req.ip ?? ''));
        res.json({ success: true, data });
      } catch (error) {
        if (error instanceof LaunchpadBusyError) {
          const search = error instanceof LaunchpadSearchBusyError;
          res.setHeader('Retry-After', String(error.retryAfterS));
          res.status(429).json({
            success: false,
            error: search ? 'Too many searches, retry shortly' : 'Too many requests for the token list, retry shortly',
            code,
          });
          return;
        }
        const db = isDatabaseError(error);
        logDeduplicator.error('GET /elysium/analytics failure', {
          code,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        sendUpstreamError(res, error, db ? 503 : 502, {
          success: false,
          error: db ? 'Analytics unavailable' : 'Analytics error',
          code,
        });
      }
    }) as RequestHandler
  );
}

register('/status', elysiumAnalyticsStatusSchema, 'ELYSIUM_ANALYTICS_STATUS_ERROR', () => service.getStatus());

register('/deployments', elysiumAnalyticsDaysSchema, 'ELYSIUM_ANALYTICS_DEPLOYMENTS_ERROR', (q) =>
  service.getDeployments(q.days)
);

register('/contracts', elysiumAnalyticsContractsSchema, 'ELYSIUM_ANALYTICS_CONTRACTS_ERROR', (q) =>
  service.getContracts(q.window)
);

register('/users', elysiumAnalyticsDaysSchema, 'ELYSIUM_ANALYTICS_USERS_ERROR', (q) => service.getUsers(q.days));

register('/bridge', elysiumAnalyticsDaysSchema, 'ELYSIUM_ANALYTICS_BRIDGE_ERROR', (q) => service.getBridge(q.days));

register('/economics', elysiumAnalyticsDaysSchema, 'ELYSIUM_ANALYTICS_ECONOMICS_ERROR', (q) =>
  service.getEconomics(q.days)
);

register('/methods', elysiumAnalyticsMethodsSchema, 'ELYSIUM_ANALYTICS_METHODS_ERROR', (q) =>
  service.getMethods(q.window)
);

register('/fees', elysiumAnalyticsFeesSchema, 'ELYSIUM_ANALYTICS_FEES_ERROR', (q) => service.getFees(q.window));

register('/dex', elysiumAnalyticsDaysSchema, 'ELYSIUM_ANALYTICS_DEX_ERROR', (q) => service.getDex(q.days));

register('/tokens', elysiumAnalyticsDaysSchema, 'ELYSIUM_ANALYTICS_TOKENS_ERROR', (q) => service.getTokens(q.days));

register('/ecosystem', elysiumAnalyticsStatusSchema, 'ELYSIUM_ANALYTICS_ECOSYSTEM_ERROR', () =>
  ecosystem.getProjects()
);

// A search is a read of the launches for every new text: its own, tighter per-IP limit.
// (A text under the minimum length is not searched: see the schema.)
const searchLimiter: RequestHandler = (req, res, next) =>
  typeof req.query.q === 'string' && req.query.q.trim().length >= LAUNCHPAD_SEARCH_MIN_CHARS
    ? elysiumSearchRateLimiter(req, res, next)
    : next();

register(
  '/launchpads',
  elysiumAnalyticsLaunchpadsSchema,
  'ELYSIUM_ANALYTICS_LAUNCHPADS_ERROR',
  (q, _p, client) => launchpadMarket.getPage(q, client),
  searchLimiter
);

// Any address is a fresh cache key and ~10 queries: tighter per-IP limit.
register(
  '/address/:address',
  elysiumAnalyticsAddressSchema,
  'ELYSIUM_ANALYTICS_ADDRESS_ERROR',
  (_q, p) => service.getAddress(p.address),
  addressLookupRateLimiter
);

register(
  '/contract/:address',
  elysiumAnalyticsAddressSchema,
  'ELYSIUM_ANALYTICS_CONTRACT_ERROR',
  (_q, p) => service.getContract(p.address),
  addressLookupRateLimiter
);

export default router;
