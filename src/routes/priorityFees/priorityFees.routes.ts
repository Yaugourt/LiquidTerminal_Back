import { Router } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { PriorityFeesService } from '../../services/priorityFees/priorityFees.service';
import { PriorityFeesError, PriorityFeesWindow } from '../../types/priorityFees.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const priorityFeesService = PriorityFeesService.getInstance();

const VALID_WINDOWS: PriorityFeesWindow[] = ['24h', '7d'];

router.get('/series', marketRateLimiter, async (req, res) => {
  const raw = (req.query.window as string | undefined) ?? '24h';
  const window = VALID_WINDOWS.includes(raw as PriorityFeesWindow)
    ? (raw as PriorityFeesWindow)
    : null;

  if (!window) {
    return res.status(400).json({
      success: false,
      error: {
        message: `Invalid window. Must be one of: ${VALID_WINDOWS.join(', ')}`,
        code: 'INVALID_WINDOW',
      },
    });
  }

  try {
    const series = await priorityFeesService.getSeries(window);
    return res.json({ success: true, data: series });
  } catch (error: unknown) {
    logDeduplicator.error('Error fetching priority fees series:', {
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof PriorityFeesError) {
      return res.status(error.statusCode).json({
        success: false,
        error: { message: error.message, code: error.code },
      });
    }
    return res.status(502).json({
      success: false,
      error: { message: 'Upstream error', code: 'PRIORITY_FEES_SERIES_ERROR' },
    });
  }
});

export default router;
