import { Router, Request, Response, RequestHandler } from 'express';
import { elysiumRpcRateLimiter, elysiumRpcWeightOf, marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation';
import { elysiumRpcBodySchema } from '../../schemas/elysium-rpc.schema';
import {
  ElysiumRpcBusyError,
  ElysiumRpcClientGoneError,
  ElysiumRpcProxyService,
  ElysiumRpcResponseTooLargeError,
} from '../../services/elysium/elysium-rpc-proxy.service';
import { rateLimitKeyForIp } from '../../utils/client-ip';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const proxy = ElysiumRpcProxyService.getInstance();

/** JSON-RPC "limit exceeded": what nodes answer when a request asks for too much. */
const LIMIT_EXCEEDED = -32005;

/**
 * POST /elysium/rpc — read-only JSON-RPC proxy to the Elysium mainnet archive
 * node. The Zod schema (elysium-rpc.schema) allows only read methods, so this
 * cannot broadcast a transaction or reach debug/admin, and bounds the
 * parameters that size the node's work. It answers raw JSON-RPC (not the
 * {success,data} envelope) so a viem transport can read it directly. The keyed
 * upstream URL lives in ELYSIUM_MAINNET_RPC_URL and never reaches the browser.
 *
 * Limits, in order: the general per-IP limiter (requests), the validation,
 * then elysiumRpcRateLimiter, which counts every call of the request against
 * the client at its weight (it runs after the validation: it needs the calls).
 * The proxy itself caps what all clients together can send and hold, with a
 * share per client (see the service).
 */
router.post(
  '/',
  marketRateLimiter,
  validateRequest(elysiumRpcBodySchema),
  elysiumRpcRateLimiter,
  (async (req: Request, res: Response) => {
    if (!proxy.isConfigured()) {
      res.status(503).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Elysium mainnet RPC not configured' },
      });
      return;
    }
    const body = req.body as { id?: number | string | null } | unknown[];
    // A whole-request error answers the call's own id; a batch has none to pick.
    const id = Array.isArray(body) ? null : (body.id ?? null);
    // A client that closes its connection before the answer is ready (its own timeout, a closed
    // tab) must not keep a slot waiting, a call at the node, or an answer in memory.
    const gone = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) gone.abort();
    };
    res.once('close', onClose);
    try {
      const answer = await proxy.forward(body, elysiumRpcWeightOf(body), rateLimitKeyForIp(req.ip ?? ''), gone.signal);
      // Written as received (no decoding, no ETag over megabytes), and released once the client has it.
      proxy.deliver(answer, res);
    } catch (error) {
      // Nobody left to answer.
      if (error instanceof ElysiumRpcClientGoneError) return;
      if (error instanceof ElysiumRpcBusyError) {
        res.setHeader('Retry-After', String(error.retryAfterS));
        res.status(429).json({
          jsonrpc: '2.0',
          id,
          error: { code: LIMIT_EXCEEDED, message: 'Elysium RPC busy, retry shortly' },
        });
        return;
      }
      if (error instanceof ElysiumRpcResponseTooLargeError) {
        // A JSON-RPC error, not an HTTP one: the request was fine, its answer
        // is too large to relay, which is for the caller to narrow.
        res.json({
          jsonrpc: '2.0',
          id,
          error: { code: LIMIT_EXCEEDED, message: 'Response too large, narrow the request' },
        });
        return;
      }
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
