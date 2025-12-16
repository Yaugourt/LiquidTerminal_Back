import { Router, Request, Response } from 'express';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireAdmin } from '../../middleware/roleMiddleware';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { xpService } from '../../services/xp/xp.service';
import { XpActionType, DailyTaskType } from '@prisma/client';
import { prisma } from '../../core/prisma.service';

const router = Router();

/**
 * Helper pour récupérer l'utilisateur depuis le token Privy
 */
async function getUserFromRequest(req: Request): Promise<{ id: number } | null> {
  const privyUserId = req.user?.sub;
  if (!privyUserId) return null;
  
  const user = await prisma.user.findUnique({ 
    where: { privyUserId },
    select: { id: true }
  });
  return user;
}

// Appliquer le rate limiting
router.use(marketRateLimiter);

/**
 * GET /xp/stats
 * Récupère les statistiques XP de l'utilisateur connecté
 */
router.get('/stats', validatePrivyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const stats = await xpService.getUserXpStats(user.id);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logDeduplicator.error('Error getting XP stats', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

/**
 * GET /xp/history
 * Récupère l'historique des transactions XP de l'utilisateur connecté
 */
router.get('/history', validatePrivyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const actionType = req.query.actionType as XpActionType | undefined;

    const history = await xpService.getTransactionHistory(user.id, {
      page,
      limit,
      actionType,
    });

    res.status(200).json({
      success: true,
      data: history,
    });
  } catch (error) {
    logDeduplicator.error('Error getting XP history', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

/**
 * GET /xp/leaderboard
 * Récupère le leaderboard XP
 */
router.get('/leaderboard', async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    // Si l'utilisateur est connecté, on récupère aussi son rang
    let userId: number | undefined;
    if (req.user?.sub) {
      const user = await getUserFromRequest(req);
      userId = user?.id;
    }

    const leaderboard = await xpService.getLeaderboard({
      page,
      limit,
      userId,
    });

    res.status(200).json({
      success: true,
      data: leaderboard,
    });
  } catch (error) {
    logDeduplicator.error('Error getting XP leaderboard', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

/**
 * POST /xp/daily-login
 * Enregistre un login quotidien et attribue l'XP correspondant
 */
router.post('/daily-login', validatePrivyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const result = await xpService.handleDailyLogin(user.id);

    res.status(200).json({
      success: true,
      message: result.xpGranted > 0 ? 'Daily login XP granted' : 'Already logged in today',
      data: result,
    });
  } catch (error) {
    logDeduplicator.error('Error handling daily login', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

/**
 * POST /xp/admin/grant
 * Route admin pour attribuer de l'XP manuellement
 */
router.post('/admin/grant', validatePrivyToken, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const admin = await getUserFromRequest(req);
    if (!admin) {
      res.status(401).json({
        success: false,
        message: 'Admin not found',
        code: 'ADMIN_NOT_FOUND',
      });
      return;
    }

    const { targetUserId, xpAmount, description } = req.body;

    if (!targetUserId || typeof xpAmount !== 'number' || !description) {
      res.status(400).json({
        success: false,
        message: 'Missing required fields: targetUserId, xpAmount, description',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const granted = await xpService.adminGrantXp(admin.id, targetUserId, xpAmount, description);

    logDeduplicator.info('Admin granted XP', {
      adminId: admin.id,
      targetUserId,
      xpAmount,
      description,
    });

    res.status(200).json({
      success: true,
      message: `Successfully granted ${granted} XP`,
      data: { xpGranted: granted },
    });
  } catch (error) {
    logDeduplicator.error('Error in admin XP grant', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

// ==================== DAILY TASKS ====================

/**
 * GET /xp/daily-tasks
 * Récupère les daily tasks du jour avec leur statut
 */
router.get('/daily-tasks', validatePrivyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const tasks = await xpService.getDailyTasks(user.id);

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    logDeduplicator.error('Error getting daily tasks', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

/**
 * POST /xp/daily-tasks/:type
 * Complète une daily task manuellement (pour les tasks comme EXPLORE_LEADERBOARD)
 */
router.post('/daily-tasks/:type', validatePrivyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const taskType = req.params.type as DailyTaskType;
    
    // Valider le type de task
    const validTypes: DailyTaskType[] = ['LOGIN', 'READ_RESOURCE', 'ADD_WALLET', 'EXPLORE_LEADERBOARD'];
    if (!validTypes.includes(taskType)) {
      res.status(400).json({
        success: false,
        message: `Invalid task type. Valid types: ${validTypes.join(', ')}`,
        code: 'INVALID_TASK_TYPE',
      });
      return;
    }

    // Seules certaines tasks peuvent être complétées manuellement
    const manuallyCompletable: DailyTaskType[] = ['EXPLORE_LEADERBOARD'];
    if (!manuallyCompletable.includes(taskType)) {
      res.status(400).json({
        success: false,
        message: `Task ${taskType} cannot be completed manually. It's completed automatically.`,
        code: 'TASK_NOT_MANUALLY_COMPLETABLE',
      });
      return;
    }

    const result = await xpService.completeDailyTask(user.id, taskType);

    res.status(200).json({
      success: true,
      message: result.xpGranted > 0 ? 'Daily task completed!' : 'Task already completed today',
      data: result,
    });
  } catch (error) {
    logDeduplicator.error('Error completing daily task', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

// ==================== WEEKLY CHALLENGES ====================

/**
 * GET /xp/weekly-challenges
 * Récupère les weekly challenges de la semaine en cours
 */
router.get('/weekly-challenges', validatePrivyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const challenges = await xpService.getWeeklyChallenges(user.id);

    res.status(200).json({
      success: true,
      data: challenges,
    });
  } catch (error) {
    logDeduplicator.error('Error getting weekly challenges', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

// ==================== DAILY LIMITS ====================

/**
 * GET /xp/daily-limits
 * Récupère les limites quotidiennes restantes pour l'utilisateur
 */
router.get('/daily-limits', validatePrivyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const limits = await xpService.getDailyLimits(user.id);

    res.status(200).json({
      success: true,
      data: limits,
    });
  } catch (error) {
    logDeduplicator.error('Error getting daily limits', {
      error: error instanceof Error ? error.message : String(error),
      privyUserId: req.user?.sub,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
});

export default router;



