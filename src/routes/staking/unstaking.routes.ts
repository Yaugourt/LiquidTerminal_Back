import { Router, Request, Response } from 'express';
import { UnstakingService } from '../../services/staking/unstaking.service';
import { UnstakingQueueResponse } from '../../types/staking.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { ValidatorError } from '../../errors/staking.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const unstakingService = UnstakingService.getInstance();

// Appliquer le rate limiter à toutes les routes
router.use(marketRateLimiter);

/**
 * @route GET /staking/unstaking-queue
 * @description Récupère toutes les données de la queue de unstaking
 * @query page - Numéro de page (défaut: 1)
 * @query limit - Nombre d'éléments par page (défaut: 50, max: 200)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    
    logDeduplicator.info('Fetching unstaking queue with pagination', { page, limit });

    const result = await unstakingService.getUnstakingQueue({ page, limit });
    const response: UnstakingQueueResponse = {
      success: true,
      data: result.data,
      pagination: result.pagination
    };

    logDeduplicator.info('Unstaking queue retrieved successfully', { 
      count: result.data.length,
      page: result.pagination.page,
      totalPages: result.pagination.totalPages,
      totalItems: result.pagination.total
    });
    
    res.json(response);
  } catch (error) {
    logDeduplicator.error('Error in /unstaking-queue route:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof ValidatorError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch unstaking queue',
        code: 'UNKNOWN_ERROR'
      });
    }
  }
});

/**
 * @route GET /staking/unstaking-queue/stats
 * @description Récupère les statistiques d'unstaking par jour
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    logDeduplicator.info('Fetching unstaking stats');

    const stats = await unstakingService.getUnstakingStats();

    logDeduplicator.info('Unstaking stats retrieved successfully', { 
      totalDays: stats.dailyStats.length,
      totalTokens: stats.totalStats.totalTokens,
      totalTransactions: stats.totalStats.totalTransactions,
      totalUniqueUsers: stats.totalStats.totalUniqueUsers
    });
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logDeduplicator.error('Error in /unstaking-queue/stats route:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof ValidatorError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch unstaking stats',
        code: 'UNKNOWN_ERROR'
      });
    }
  }
});

export default router; 