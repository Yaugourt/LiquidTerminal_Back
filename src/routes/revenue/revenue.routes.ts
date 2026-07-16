import { Router } from 'express';
import { RevenueService } from '../../services/revenue/revenue.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { RevenueError, RevenueWindow, REVENUE_WINDOWS } from '../../types/revenue.types';

const router = Router();
const revenueService = RevenueService.getInstance();

/**
 * @route GET /market/revenue/history?window=7d|30d|90d|1y|all
 * Daily protocol-revenue breakdown (perp/spot real, other sources pending).
 * Defaults to a 30-day window.
 */
router.get('/history', async (req, res) => {
  const rawWindow = typeof req.query.window === 'string' ? req.query.window : '30d';

  if (!REVENUE_WINDOWS.includes(rawWindow as RevenueWindow)) {
    res.status(400).json({
      success: false,
      error: {
        message: `Invalid window "${rawWindow}". Expected one of: ${REVENUE_WINDOWS.join(', ')}.`,
        code: 'REVENUE_INVALID_WINDOW',
      },
    });
    return;
  }

  try {
    const breakdown = await revenueService.getBreakdown(rawWindow as RevenueWindow);
    res.json({
      success: true,
      data: breakdown,
    });
  } catch (error: unknown) {
    logDeduplicator.error('Error fetching revenue breakdown:', {
      window: rawWindow,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof RevenueError) {
      res.status(error.statusCode).json({
        success: false,
        error: { message: error.message, code: error.code },
      });
    } else {
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          code: 'INTERNAL_SERVER_ERROR',
        },
      });
    }
  }
});

export default router;
