import { Router, Request, Response, RequestHandler } from 'express';
import { MetricsHistoryService } from '../../services/metrics/metrics-history.service';
import { isMetricKey } from '../../types/metrics-history.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = MetricsHistoryService.getInstance();

/**
 * GET /market/metrics/history?metric=total_oi&hours=168
 * Stored hourly history of a self-sampled headline metric, oldest first.
 * `metric` is one of: total_oi, active_users_24h. Empty until the historical
 * table is migrated; fills going forward (no upstream backfill exists).
 */
router.get('/history',
  marketRateLimiter,
  (async (req: Request, res: Response) => {
    try {
      const metric = typeof req.query.metric === 'string' ? req.query.metric : '';
      if (!isMetricKey(metric)) {
        return res.status(400).json({
          success: false,
          error: 'Unknown or missing metric',
          code: 'INVALID_METRIC',
        });
      }
      const raw = typeof req.query.hours === 'string' ? parseInt(req.query.hours, 10) : NaN;
      const hours = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 8760) : 168;

      const response = await service.getHistory(metric, hours);
      res.json(response);
    } catch (error) {
      logDeduplicator.error('Error fetching metric history:', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    }
  }) as RequestHandler
);

export default router;
