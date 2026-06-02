import { Router } from 'express';
import { RevenueService } from '../../services/revenue/revenue.service';
import { RevenueError, RevenueWindow } from '../../types/revenue.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const revenueService = RevenueService.getInstance();

const VALID_WINDOWS: RevenueWindow[] = ['7d', '30d', '90d', '1y', 'all'];

router.get('/history', async (req, res) => {
  const raw = (req.query.window as string | undefined) ?? '30d';
  const window = VALID_WINDOWS.includes(raw as RevenueWindow) ? (raw as RevenueWindow) : null;

  if (!window) {
    return res.status(400).json({
      success: false,
      error: { message: `Invalid window. Must be one of: ${VALID_WINDOWS.join(', ')}`, code: 'INVALID_WINDOW' },
    });
  }

  try {
    const breakdown = await revenueService.getBreakdown(window);
    return res.json({ success: true, data: breakdown });
  } catch (error: unknown) {
    logDeduplicator.error('Error fetching revenue breakdown:', { error: error instanceof Error ? error.message : String(error) });

    if (error instanceof RevenueError) {
      return res.status(error.statusCode).json({
        success: false,
        error: { message: error.message, code: error.code },
      });
    }
    return res.status(500).json({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Internal server error', code: 'INTERNAL_SERVER_ERROR' },
    });
  }
});

export default router;
