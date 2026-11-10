import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation';
import { elysiumRpcBodySchema } from '../../schemas/elysium-rpc.schema';
import { ElysiumRpcProxyService } from '../../services/elysium/elysium-rpc-proxy.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const proxy = ElysiumRpcProxyService.getInstance();

/**
 * POST /elysium/rpc — read-only JSON-RPC proxy to the Elysium mainnet archive
 * node. The Zod schema (elysium-rpc.schema) allows only read methods, so this
 * cannot broadcast a transaction or reach debug/admin. It answers raw JSON-RPC
 * (not the {success,data} envelope) so a viem transport can read it directly.
 * The keyed upstream URL lives in ELYSIUM_MAINNET_RPC_URL and never reaches the
 * browser.
 */
router.post(
  '/',
  marketRateLimiter,
  validateRequest(elysiumRpcBodySchema),
  (async (req: Request, res: Response) => {
    if (!proxy.isConfigured()) {
      res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Elysium mainnet RPC not configured' },
      });
      return;
    }
    try {
      const result = await proxy.forward(req.body);
      res.json(result);
    } catch (error) {
      logDeduplicator.error('POST /elysium/rpc', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Elysium RPC temporarily unavailable' },
      });
    }
  }) as RequestHandler
);

export default router;
