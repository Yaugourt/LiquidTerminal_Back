import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import {
  hyperfolioHistorySchema,
  hyperfolioNftsQuerySchema,
  hyperfolioNftsSchema,
  hyperfolioTransactionsQuerySchema,
  hyperfolioTransactionsSchema,
  hyperfolioWalletParamsSchema,
  hyperfolioYieldQuerySchema,
  hyperfolioYieldSchema,
} from '../../schemas/hyperfolio.schema';
import { HyperfolioRead, HyperfolioService } from '../../services/hyperfolio/hyperfolio.service';
import { HyperfolioClient } from '../../clients/hyperfolio/hyperfolio.client';
import { isHyperfolioConfigured } from '../../clients/hyperfolio/hyperfolio-api.config';
import {
  HyperfolioError,
  HyperfolioNotConfiguredError,
  HyperfolioRateLimitedError,
  HyperfolioThrottledError,
} from '../../errors/hyperfolio.errors';
import { HYPERFOLIO_STREAM } from '../../constants/hyperfolio.cache';
import {
  HyperfolioPortfolioStats,
  HyperfolioPositionsResponse,
  HyperfolioProtocol,
  HyperfolioStreamEvent,
} from '../../types/hyperfolio.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { rateLimitKeyForIp } from '../../utils/client-ip';

const router = Router();
const service = HyperfolioService.getInstance();
const client = HyperfolioClient.getInstance();

const DEFAULT_HISTORY_DAYS = 30;

/**
 * Run a handler and shape the response; map Hyperfolio domain errors to their
 * status. `stale: true` marks the last copy served because a refresh was
 * refused or failed.
 */
function run(handler: (req: Request) => Promise<HyperfolioRead<unknown>>, label: string): RequestHandler {
  return (async (req: Request, res: Response) => {
    try {
      const { data, stale } = await handler(req);
      res.json({ success: true, data, ...(stale ? { stale: true } : {}) });
    } catch (error) {
      if (error instanceof HyperfolioError) {
        if (error.statusCode === 429) {
          res.setHeader('Retry-After', '10');
        }
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code,
        });
      }
      logDeduplicator.error(label, { error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({
        success: false,
        error: 'Upstream error',
        code: 'HYPERFOLIO_ERROR',
      });
    }
  }) as RequestHandler;
}

const address = (req: Request): string => String(req.params.address);

/** Caller key for the per-IP upstream budget (`trust proxy` is set in app.ts). */
/** Budget key for the caller: its IP, or its /64 when on IPv6. */
function clientIp(req: Request): string {
  return rateLimitKeyForIp(req.ip || req.socket.remoteAddress || 'unknown');
}

// ==================== Wallet (JSON) ====================

router.get(
  '/wallet/:address/composition',
  marketRateLimiter,
  validateGetRequest(hyperfolioWalletParamsSchema),
  run((req) => service.getComposition(address(req), clientIp(req)), 'GET /hyperfolio/wallet/:address/composition')
);

router.get(
  '/wallet/:address/positions',
  marketRateLimiter,
  validateGetRequest(hyperfolioWalletParamsSchema),
  run((req) => service.getPositions(address(req), clientIp(req)), 'GET /hyperfolio/wallet/:address/positions')
);

router.get(
  '/wallet/:address/history',
  marketRateLimiter,
  validateGetRequest(hyperfolioHistorySchema),
  run((req) => {
    const days = req.query.days ? Number(req.query.days) : DEFAULT_HISTORY_DAYS;
    return service.getPortfolioHistory(address(req), days, clientIp(req));
  }, 'GET /hyperfolio/wallet/:address/history')
);

router.get(
  '/wallet/:address/transactions',
  marketRateLimiter,
  validateGetRequest(hyperfolioTransactionsSchema),
  run((req) => {
    const query = hyperfolioTransactionsQuerySchema.parse(req.query);
    return service.getTransactions(address(req), query, clientIp(req));
  }, 'GET /hyperfolio/wallet/:address/transactions')
);

router.get(
  '/wallet/:address/nfts',
  marketRateLimiter,
  validateGetRequest(hyperfolioNftsSchema),
  run((req) => {
    const query = hyperfolioNftsQuerySchema.parse(req.query);
    return service.getNfts(address(req), query, clientIp(req));
  }, 'GET /hyperfolio/wallet/:address/nfts')
);

router.get(
  '/wallet/:address/points',
  marketRateLimiter,
  validateGetRequest(hyperfolioWalletParamsSchema),
  run((req) => service.getPoints(address(req), clientIp(req)), 'GET /hyperfolio/wallet/:address/points')
);

// ==================== Yield (JSON) ====================

router.get(
  '/yield',
  marketRateLimiter,
  validateGetRequest(hyperfolioYieldSchema),
  run(
    (req) => service.getYield(hyperfolioYieldQuerySchema.parse(req.query), clientIp(req)),
    'GET /hyperfolio/yield'
  )
);

// ==================== Positions stream (SSE proxy) ====================

const streamsPerIp = new Map<string, number>();
let totalStreams = 0;

function writeEvent(res: Response, id: number, payload: unknown): boolean {
  return res.write(`event: message\nid: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sseHeaders(res: Response, source: 'cache' | 'upstream'): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-LT-Source', source);
  res.flushHeaders();
}

/** Replay a cached `/positions` answer with the same framing as the live stream. */
function replayFromCache(res: Response, cached: HyperfolioPositionsResponse): void {
  sseHeaders(res, 'cache');
  const total = cached.data.protocols.length;
  let id = 0;
  cached.data.protocols.forEach((protocol, index) => {
    id += 1;
    writeEvent(res, id, {
      type: 'protocol',
      data: protocol,
      progress: { completed: index + 1, total },
    });
  });
  writeEvent(res, id + 1, {
    type: 'complete',
    progress: { completed: total, total },
    portfolioStats: cached.data.portfolioStats,
  });
  res.end();
}

/**
 * Incremental SSE parser: feeds upstream text, yields every parsed `data:` JSON.
 * Blocks are separated by a blank line; multi-line `data:` fields are joined.
 */
class SseBlockParser {
  private buffer = '';

  public push(chunk: string): HyperfolioStreamEvent[] {
    this.buffer += chunk;
    const events: HyperfolioStreamEvent[] = [];
    let boundary = this.buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        try {
          events.push(JSON.parse(data) as HyperfolioStreamEvent);
        } catch {
          // ignore malformed upstream frames
        }
      }
      boundary = this.buffer.search(/\r?\n\r?\n/);
    }
    return events;
  }
}

/**
 * GET /hyperfolio/wallet/:address/positions/stream
 * Proxies Hyperfolio's SSE so the API key never reaches the browser. A fresh
 * cached `/positions` answer is replayed instantly; otherwise the upstream
 * stream is forwarded chunk by chunk and, once complete, warms that cache.
 * Guarded like the JSON routes: marketRateLimiter counts the open (not its
 * duration), an upstream open spends the caller's per-IP budget — so an
 * open/abort loop cannot fan out fresh 30-protocol scans — and concurrent
 * streams are capped per IP and in total (503 + Retry-After past them).
 */
router.get(
  '/wallet/:address/positions/stream',
  marketRateLimiter,
  validateGetRequest(hyperfolioWalletParamsSchema),
  (async (req: Request, res: Response) => {
    const wallet = address(req);

    if (!isHyperfolioConfigured()) {
      const err = new HyperfolioNotConfiguredError();
      return res.status(err.statusCode).json({ success: false, error: err.message, code: err.code });
    }

    const cached = await service.peekPositions(wallet);
    if (cached) {
      return replayFromCache(res, cached);
    }

    if (service.isRateLimited()) {
      const err = new HyperfolioRateLimitedError();
      res.setHeader('Retry-After', '10');
      return res.status(err.statusCode).json({ success: false, error: err.message, code: err.code });
    }

    const ip = clientIp(req);
    const perIp = streamsPerIp.get(ip) ?? 0;
    if (
      perIp >= HYPERFOLIO_STREAM.MAX_CONNECTIONS_PER_IP ||
      totalStreams >= HYPERFOLIO_STREAM.MAX_TOTAL_CONNECTIONS
    ) {
      // Temporary: a slot frees as soon as a stream completes. 503 + a short
      // Retry-After so the front retries instead of showing no positions.
      res.setHeader('Retry-After', String(HYPERFOLIO_STREAM.RETRY_AFTER_S));
      return res.status(503).json({
        success: false,
        error: 'Connection limit reached',
        code: 'SSE_CONNECTION_LIMIT',
      });
    }
    if (!client.checkRateLimit(ip)) {
      const err = new HyperfolioThrottledError();
      res.setHeader('Retry-After', '10');
      return res.status(err.statusCode).json({ success: false, error: err.message, code: err.code });
    }
    // The client may have left during the awaits above: its `close` already
    // fired, so a slot taken now would never be released.
    if (req.destroyed || res.destroyed) return;
    streamsPerIp.set(ip, perIp + 1);
    totalStreams += 1;

    req.setTimeout(0);
    res.setTimeout(0);

    const controller = new AbortController();
    const parser = new SseBlockParser();
    const protocols: HyperfolioProtocol[] = [];
    let portfolioStats: HyperfolioPortfolioStats | undefined;
    let completed = false;
    let timedOut = false;
    let released = false;
    let heartbeat: NodeJS.Timeout | null = null;

    const release = (): void => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      controller.abort();
      streamsPerIp.set(ip, Math.max(0, (streamsPerIp.get(ip) ?? 1) - 1));
      if ((streamsPerIp.get(ip) ?? 0) === 0) streamsPerIp.delete(ip);
      totalStreams = Math.max(0, totalStreams - 1);
    };

    req.on('close', release);
    req.on('error', release);
    res.on('close', release);
    res.on('error', release);

    const upstreamTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, HYPERFOLIO_STREAM.UPSTREAM_TIMEOUT_MS);

    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = await client.openPositionsStream(wallet, controller.signal);
    } catch (error) {
      clearTimeout(upstreamTimeout);
      release();
      if (error instanceof HyperfolioError) {
        // Only a real upstream throttle opens the shared cooldown; our own
        // process-wide budget refusing a slot must not lock everyone out.
        if (error instanceof HyperfolioRateLimitedError) service.markRateLimited();
        if (error.statusCode === 429) res.setHeader('Retry-After', '10');
        return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
      }
      logDeduplicator.error('GET /hyperfolio/wallet/:address/positions/stream', {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json({ success: false, error: 'Upstream error', code: 'HYPERFOLIO_ERROR' });
    }

    // Client gone while the upstream was opening: release() already ran, so a
    // heartbeat started now would never be cleared.
    if (released || res.destroyed) {
      clearTimeout(upstreamTimeout);
      upstream.cancel().catch(() => undefined);
      release();
      return;
    }

    sseHeaders(res, 'upstream');
    heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        release();
        return;
      }
      res.write(': ping\n\n');
    }, HYPERFOLIO_STREAM.HEARTBEAT_INTERVAL_MS);

    const decoder = new TextDecoder();
    const reader = upstream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (!res.write(text)) {
          // A destroyed response never emits drain/close again, and a stalled
          // reader must not outlive the upstream timeout: also wake on abort.
          if (res.destroyed) break;
          await new Promise<void>((resolve) => {
            const { signal } = controller;
            const finish = (): void => {
              res.off('drain', finish);
              res.off('close', finish);
              res.off('error', finish);
              signal.removeEventListener('abort', finish);
              resolve();
            };
            if (signal.aborted) return resolve();
            res.once('drain', finish);
            res.once('close', finish);
            res.once('error', finish);
            signal.addEventListener('abort', finish, { once: true });
          });
          if (timedOut) throw new Error('Upstream stream timed out');
          if (controller.signal.aborted) break;
        }
        for (const event of parser.push(text)) {
          if (event.type === 'protocol') protocols.push(event.data);
          if (event.type === 'complete') {
            completed = true;
            portfolioStats = event.portfolioStats;
          }
        }
        if (req.destroyed || res.destroyed || res.writableEnded) break;
      }
    } catch (error) {
      // A client disconnect aborts too; only then is there nobody to tell.
      if ((timedOut || !controller.signal.aborted) && !res.writableEnded) {
        writeEvent(res, 0, {
          type: 'error',
          error: timedOut ? 'Upstream stream timed out' : 'Upstream stream interrupted',
          fatal: true,
        });
      }
      if (controller.signal.aborted && !timedOut) {
        logDeduplicator.info('Hyperfolio positions stream closed by client');
      } else {
        logDeduplicator.warn('Hyperfolio positions stream interrupted', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      clearTimeout(upstreamTimeout);
      reader.releaseLock();
      release();
      if (!res.writableEnded) res.end();
    }

    if (completed && portfolioStats) {
      await service.storePositions(wallet, {
        data: { protocols, portfolioStats },
        cache: {
          lastUpdate: new Date().toISOString(),
          cacheAge: 'just now',
          cacheAgeSeconds: 0,
          source: 'api',
          isStale: false,
        },
      });
    }
  }) as RequestHandler
);

export default router;
