import express, { Request, Response, RequestHandler } from 'express';
import { LeaderboardService } from '../../services/leaderboard/leaderboard.service';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import { leaderboardGetSchema } from '../../schemas/leaderboard.schema';
import { LeaderboardError } from '../../types/leaderboard.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const leaderboardService = LeaderboardService.getInstance();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

/**
 * GET /leaderboard
 * Récupère le leaderboard avec tri et pagination
 * 
 * Query params:
 * - timeline: 'day' | 'week' | 'month' | 'allTime' (default: 'day')
 * - sortBy: 'pnl' | 'roi' | 'vlm' (default: 'pnl')
 * - order: 'asc' | 'desc' (default: 'desc')
 * - page: number (default: 1)
 * - limit: number (default: 20, max: 100)
 */
router.get('/', 
  validateGetRequest(leaderboardGetSchema),
  (async (req: Request, res: Response) => {
    try {
      const { timeline, sortBy, order, page, limit } = req.query;
      const params = {
        timeline: timeline as 'day' | 'week' | 'month' | 'allTime' || 'day',
        sortBy: sortBy as 'pnl' | 'roi' | 'vlm' || 'pnl',
        order: order as 'asc' | 'desc' || 'desc',
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20
      };
      
      const result = await leaderboardService.getLeaderboard(params);
      
      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination,
        query: params,
        lastUpdate: leaderboardService.getLastUpdate()
      });
    } catch (error) {
      logDeduplicator.error('Error fetching leaderboard:', { 
        error: error instanceof Error ? error.message : String(error),
        query: req.query 
      });
      
      if (error instanceof LeaderboardError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code
        });
      }
      
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

/**
 * GET /leaderboard/stats
 * Récupère les statistiques du leaderboard
 */
router.get('/stats', (async (req: Request, res: Response) => {
  try {
    const allData = await leaderboardService.getLeaderboard({ 
      timeline: 'allTime', 
      sortBy: 'pnl', 
      order: 'desc',
      page: 1,
      limit: 1000 // Récupérer plus de données pour les stats
    });

    const stats = {
      totalParticipants: allData.pagination.total,
      topPerformer: allData.data[0] || null,
      averageAccountValue: allData.data.reduce((sum, entry) => sum + entry.accountValue, 0) / allData.data.length,
      totalVolume: allData.data.reduce((sum, entry) => sum + parseFloat(entry.allTime.vlm), 0),
      totalPnl: allData.data.reduce((sum, entry) => sum + parseFloat(entry.allTime.pnl), 0),
      lastUpdate: leaderboardService.getLastUpdate()
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logDeduplicator.error('Error fetching leaderboard stats:', { 
      error: error instanceof Error ? error.message : String(error)
    });
    
    if (error instanceof LeaderboardError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

/**
 * GET /leaderboard/user/:ethAddress
 * Récupère les informations d'un utilisateur spécifique
 */
router.get('/user/:ethAddress', (async (req: Request, res: Response) => {
  try {
    const ethAddress = String(req.params.ethAddress);

    if (!ethAddress || !/^0x[a-fA-F0-9]{40}$/.test(ethAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Ethereum address format',
        code: 'INVALID_ETH_ADDRESS'
      });
    }

    const entry = await leaderboardService.getLeaderboardEntry(ethAddress);
    
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'User not found in leaderboard',
        code: 'USER_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      data: entry,
      lastUpdate: leaderboardService.getLastUpdate()
    });
  } catch (error) {
    logDeduplicator.error('Error fetching leaderboard user:', { 
      error: error instanceof Error ? error.message : String(error),
      ethAddress: req.params.ethAddress 
    });
    
    if (error instanceof LeaderboardError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

/**
 * GET /leaderboard/timelines
 * Récupère les différentes timelines disponibles avec leurs critères de tri
 */
router.get('/timelines', (req: Request, res: Response) => {
  const timelines = {
    day: {
      name: 'Daily',
      description: 'Performance over the last 24 hours',
      sortOptions: ['pnl', 'roi', 'vlm']
    },
    week: {
      name: 'Weekly',
      description: 'Performance over the last 7 days',
      sortOptions: ['pnl', 'roi', 'vlm']
    },
    month: {
      name: 'Monthly',
      description: 'Performance over the last 30 days',
      sortOptions: ['pnl', 'roi', 'vlm']
    },
    allTime: {
      name: 'All Time',
      description: 'Performance since account creation',
      sortOptions: ['pnl', 'roi', 'vlm']
    }
  };

  res.json({
    success: true,
    data: timelines,
    sortCriteria: {
      pnl: 'Profit and Loss',
      roi: 'Return on Investment',
      vlm: 'Volume'
    }
  });
});

export default router; 