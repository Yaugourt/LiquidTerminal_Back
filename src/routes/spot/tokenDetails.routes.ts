import express, { Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import {
  TokenDetailsService,
  TokenDetailsUnavailableError,
  UnknownTokenIdError,
} from '../../services/spot/tokenDetails.service';
import { rateLimitKeyForIp } from '../../utils/client-ip';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const tokenDetailsService = TokenDetailsService.getInstance();

router.use(marketRateLimiter);

/** Hyperliquid token ids: 0x + 32 hex digits. */
const TOKEN_ID_RE = /^0x[0-9a-fA-F]{32}$/;

/**
 * GET /market/token-details/:tokenId
 * Hyperliquid `tokenDetails` of a spot token without its address lists:
 * supply, prices and deploy record as Hyperliquid sends them, plus the length
 * of each list (genesisUserCount, genesisExistingTokenCount,
 * nonCirculatingUserCount). Read from Hyperliquid at most once a minute.
 */
router.get('/:tokenId',
  (async (req: Request, res: Response) => {
    const tokenId = String(req.params.tokenId);
    if (!TOKEN_ID_RE.test(tokenId)) {
      return res.status(400).json({ success: false, error: 'Invalid token id', code: 'INVALID_PARAMS' });
    }

    try {
      // Budget key for the caller: its IP, or its /64 on IPv6 (`trust proxy` is set in app.ts).
      const client = rateLimitKeyForIp(req.ip || req.socket.remoteAddress || 'unknown');
      const { details, lastUpdate } = await tokenDetailsService.getTokenDetails(tokenId, client);
      res.json({ success: true, data: details, lastUpdate });
    } catch (error) {
      if (error instanceof UnknownTokenIdError) {
        return res.status(404).json({ success: false, error: error.message, code: 'UNKNOWN_TOKEN' });
      }
      logDeduplicator.error('Error fetching token details:', {
        tokenId,
        error: error instanceof Error ? error.message : String(error),
      });
      const unavailable = error instanceof TokenDetailsUnavailableError;
      res.status(unavailable ? 503 : 500).json({
        success: false,
        error: unavailable ? 'Token details temporarily unavailable' : 'Internal server error',
        code: unavailable ? 'TOKEN_DETAILS_UNAVAILABLE' : 'TOKEN_DETAILS_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
