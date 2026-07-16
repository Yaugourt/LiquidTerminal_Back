import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  defillamaEmptyQuerySchema,
  defillamaFeesSchema,
  defillamaPricesParamSchema,
  defillamaSlugParamSchema,
} from '../../schemas/defillama.schema';
import { DefiLlamaService } from '../../services/defillama/defillama.service';
import { DefiLlamaContextService } from '../../services/defillama/defillama-context.service';
import { DefiLlamaFeesDataType } from '../../clients/defillama/defillama.client';
import { DefiLlamaError } from '../../errors/defillama.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = DefiLlamaService.getInstance();
const contextService = DefiLlamaContextService.getInstance();

/** Run a handler and shape the response; map DefiLlama domain errors to their status. */
function run(handler: (req: Request) => Promise<unknown>, label: string): RequestHandler {
  return (async (req: Request, res: Response) => {
    try {
      const data = await handler(req);
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof DefiLlamaError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code,
        });
      }
      logDeduplicator.error(label, { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'Upstream error',
        code: 'DEFILLAMA_ERROR',
      });
    }
  }) as RequestHandler;
}

// List endpoints
router.get(
  '/protocols',
  marketRateLimiter,
  validateGetRequest(defillamaEmptyQuerySchema),
  run(() => service.getProtocols(), 'GET /defillama/protocols')
);

router.get(
  '/chains',
  marketRateLimiter,
  validateGetRequest(defillamaEmptyQuerySchema),
  run(() => service.getChains(), 'GET /defillama/chains')
);

// Hyperliquid banner figures (chain TVL, fees 24h, DEX volume 24h, protocols tracked).
router.get(
  '/chain-stats',
  marketRateLimiter,
  validateGetRequest(defillamaEmptyQuerySchema),
  run(() => contextService.getChainStats(), 'GET /defillama/chain-stats')
);

// Light daily TVL series (HL + global), tokens stripped from the upstream payload.
router.get(
  '/tvl-history/:slug',
  marketRateLimiter,
  validateGetRequest(defillamaSlugParamSchema),
  run((req) => contextService.getTvlHistory(String(req.params.slug)), 'GET /defillama/tvl-history/:slug')
);

// Per-project aggregate — the primary source for a project page.
router.get(
  '/overview/:slug',
  marketRateLimiter,
  validateGetRequest(defillamaSlugParamSchema),
  run((req) => service.getProjectOverview(String(req.params.slug)), 'GET /defillama/overview/:slug')
);

// Per-project raw views
router.get(
  '/protocol/:slug',
  marketRateLimiter,
  validateGetRequest(defillamaSlugParamSchema),
  run((req) => service.getProtocol(String(req.params.slug)), 'GET /defillama/protocol/:slug')
);

router.get(
  '/tvl/:slug',
  marketRateLimiter,
  validateGetRequest(defillamaSlugParamSchema),
  run((req) => service.getProtocolTvl(String(req.params.slug)), 'GET /defillama/tvl/:slug')
);

router.get(
  '/dexs/:slug',
  marketRateLimiter,
  validateGetRequest(defillamaSlugParamSchema),
  run((req) => service.getDexSummary(String(req.params.slug)), 'GET /defillama/dexs/:slug')
);

router.get(
  '/fees/:slug',
  marketRateLimiter,
  validateGetRequest(defillamaFeesSchema),
  run(
    (req) => service.getFeesSummary(String(req.params.slug), req.query.dataType as DefiLlamaFeesDataType | undefined),
    'GET /defillama/fees/:slug'
  )
);

router.get(
  '/prices/:coins',
  marketRateLimiter,
  validateGetRequest(defillamaPricesParamSchema),
  run((req) => service.getPrices(String(req.params.coins)), 'GET /defillama/prices/:coins')
);

export default router;
