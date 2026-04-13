import express, { Request, Response, RequestHandler } from 'express';
import { PerpGlobalStatsService } from '../../services/perp/perpStats.service';
import { validateGetRequest } from '../../middleware/validation';
import { globalPerpStatsGetSchema } from '../../schemas/perp.schemas';
import { PerpGlobalStatsError } from '../../errors/perp.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const perpGlobalStatsService = PerpGlobalStatsService.getInstance();

router.get('/', validateGetRequest(globalPerpStatsGetSchema), (async (_req: Request, res: Response) => {
  try {
    const stats = await perpGlobalStatsService.getPerpGlobalStats();
    logDeduplicator.info('Perp global stats retrieved successfully', { 
      totalOpenInterest: stats.totalOpenInterest,
      totalVolume24h: stats.totalVolume24h,
      totalPairs: stats.totalPairs,
      hlpTvl: stats.hlpTvl
    });
    res.json(stats);
  } catch (error) {
    logDeduplicator.error('Error fetching perp global stats:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof PerpGlobalStatsError) {
      return res.status(error.statusCode).json({
        error: error.code,
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'PERP_GLOBAL_STATS_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}) as RequestHandler);

export default router; 