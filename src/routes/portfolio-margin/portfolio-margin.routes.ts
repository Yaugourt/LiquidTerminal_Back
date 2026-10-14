import express, { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { PortfolioMarginService } from '../../services/portfolio-margin/portfolio-margin.service';

/**
 * Hyperliquid portfolio margin: reserves, the accounts found so far and the
 * reserve history. See PortfolioMarginService for where each number comes from.
 */
const router = express.Router();
const service = PortfolioMarginService.getInstance();
router.use(marketRateLimiter);

const historySchema = z.object({
  token: z.coerce.number().int().min(0).max(100_000).default(0),
  interval: z.enum(['1h', '4h', '1d']).default('1h'),
});

const unavailable = (res: Response, context: string, error: unknown) => {
  logDeduplicator.warn(context, { error: error instanceof Error ? error.message : String(error) });
  res.status(502).json({ success: false, error: 'Portfolio margin data unavailable', code: 'UPSTREAM_UNAVAILABLE' });
};

/** GET /market/portfolio-margin → { reserves, accounts, scan, updatedAt } */
router.get('/', (async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ success: true, data: await service.getSnapshot() });
  } catch (error) {
    unavailable(res, 'portfolio-margin snapshot failed', error);
  }
}) as RequestHandler);

/** GET /market/portfolio-margin/history?token=0&interval=1h → reserve history since 2026-09-23 */
router.get('/history', (async (req: Request, res: Response) => {
  const parsed = historySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'token: token index, interval: 1h | 4h | 1d', code: 'VALIDATION_ERROR' });
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, data: await service.getHistory(parsed.data.token, parsed.data.interval) });
  } catch (error) {
    unavailable(res, 'portfolio-margin history failed', error);
  }
}) as RequestHandler);

export default router;
