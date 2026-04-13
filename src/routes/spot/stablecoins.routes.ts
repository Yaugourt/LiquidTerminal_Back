import express, { Request, Response, RequestHandler } from 'express';
import { SpotGlobalStatsService } from '../../services/spot/spotStats.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const spotGlobalStatsService = new SpotGlobalStatsService();

router.get('/', (async (_req: Request, res: Response) => {
  try {
    const stats = await spotGlobalStatsService.getStablecoinsStats();
    res.json(stats);
  } catch (error) {
    logDeduplicator.error('Error fetching stablecoins stats:', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      error: 'Failed to fetch stablecoins stats',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}) as RequestHandler);

router.get('/history', (async (_req: Request, res: Response) => {
  try {
    const history = await spotGlobalStatsService.getStablecoinsHistory();
    res.json(history);
  } catch (error) {
    logDeduplicator.error('Error fetching stablecoins history:', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      error: 'Failed to fetch stablecoins history',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}) as RequestHandler);

export default router;
