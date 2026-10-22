import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter, passthroughRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import { candlesQuerySchema } from '../../schemas/indexer/candles.schema';
import { HypeDexerCandlesClient, type CandleInterval } from '../../clients/hypedexer/rest/candles/candles.client';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const client = HypeDexerCandlesClient.getInstance();

/** Bars per request at most: keeps a 5s chart at ~7 hours and bounds the upstream scan. */
const MAX_BARS = 5000;
const STEP_MS: Record<CandleInterval, number> = { '5s': 5e3, '30s': 30e3, '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

/**
 * GET /indexer/candles: OHLCV bars from the indexer, Hyperliquid candle
 * format, intervals 5s to 1d. The window is clamped to MAX_BARS bars.
 *
 * Each distinct (coin, interval, start, end) is a paid upstream read of up to
 * 5000 bars, so it sits behind the pass-through limiter, and the schema only
 * accepts the coins and the end times (now, up to a day back) the charts send.
 */
router.get(
  '/',
  marketRateLimiter,
  passthroughRateLimiter,
  validateGetRequest(candlesQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const parsed = candlesQuerySchema.shape.query.parse(req.query);
      const endTime = Math.min(parsed.endTime ?? Date.now(), Date.now());
      const startTime = Math.max(parsed.startTime, endTime - MAX_BARS * STEP_MS[parsed.interval]);
      const data = await client.getCandles(parsed.coin, parsed.interval, startTime, endTime);
      res.json({ success: true, data });
    } catch (e) {
      logDeduplicator.error('GET /indexer/candles', { error: e instanceof Error ? e.message : String(e) });
      res.status(502).json({ success: false, error: 'Candles unavailable', code: 'INDEXER_CANDLES_ERROR' });
    }
  }) as RequestHandler
);

export default router;
