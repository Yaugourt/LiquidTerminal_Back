import { Request, RequestHandler, Response } from 'express';
import { HypurrscanFeedUnavailableError } from '../services/hypurrscan/hypurrscanFeeds.service';
import { logDeduplicator } from '../utils/logDeduplicator';

/**
 * GET handler for a Hypurrscan feed: `{ success, data }` with the feed as
 * sent. A feed that can't be read and isn't cached is a temporary condition
 * (503 with a code and a short Retry-After), never a 500.
 */
export function hypurrscanFeedHandler(read: () => Promise<unknown>): RequestHandler {
  return (async (_req: Request, res: Response) => {
    try {
      res.status(200).json({ success: true, data: await read() });
    } catch (error) {
      if (error instanceof HypurrscanFeedUnavailableError) {
        res.setHeader('Retry-After', '30');
        return res.status(503).json({
          success: false,
          error: 'Hypurrscan data temporarily unavailable',
          code: 'HYPURRSCAN_FEED_UNAVAILABLE',
        });
      }
      logDeduplicator.error('Hypurrscan feed error:', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }) as RequestHandler;
}
