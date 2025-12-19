import { XpActionType, User, DailyTaskType, WeeklyChallengeType } from '@prisma/client';
import { xpRepository } from '../../repositories/xp.repository';
import { userRepository } from '../../repositories/user.repository';
import { logDeduplicator } from '../../utils/logDeduplicator';
import {
  XP_REWARDS,
  calculateLevel,
  calculateLevelProgress,
  ONE_TIME_ACTIONS,
  DAILY_ACTIONS,
  STREAK_MILESTONES,
  DAILY_CAPS,
  DAILY_TASKS_CONFIG,
  DAILY_COMPLETION_BONUS,
  WEEKLY_CHALLENGES_CONFIG,
  WEEKLY_CAPS,
} from '../../constants/xp.constants';
import {
  UserXpStats,
  XpLeaderboardResponse,
  GrantXpInput,
  XpTransactionHistoryResponse,
} from '../../types/xp.types';

export class XpService {
  private static instance: XpService;

  private constructor() { }

  public static getInstance(): XpService {
    if (!XpService.instance) {
      XpService.instance = new XpService();
    }
    return XpService.instance;
  }

  /**
   * Attribue de l'XP à un utilisateur pour une action
   * @returns L'XP attribué (0 si action déjà effectuée ou cap atteint)
   */
  async grantXp(input: GrantXpInput): Promise<number> {
    const { userId, actionType, referenceId, description, customXpAmount } = input;

    try {
      // Vérifier si c'est une action unique déjà effectuée
      if (ONE_TIME_ACTIONS.includes(actionType)) {
        const exists = await xpRepository.transactionExists(userId, actionType, referenceId);
        if (exists) {
          logDeduplicator.info('XP action already granted (one-time)', { userId, actionType });
          return 0;
        }
      }

      // Vérifier si c'est une action quotidienne déjà effectuée aujourd'hui
      if (DAILY_ACTIONS.includes(actionType)) {
        const hasDone = await xpRepository.hasDailyAction(userId, actionType);
        if (hasDone) {
          logDeduplicator.info('XP action already granted today', { userId, actionType });
          return 0;
        }
      }

      // Vérifier le cap journalier (anti-farm)
      const dailyCap = DAILY_CAPS[actionType];
      if (dailyCap !== undefined) {
        const today = new Date();
        const currentCount = await xpRepository.getDailyActionCount(userId, actionType, today);
        if (currentCount >= dailyCap) {
          logDeduplicator.info('Daily cap reached for action', { userId, actionType, cap: dailyCap, currentCount });
          return 0;
        }
        // Incrémenter le compteur après vérification
        await xpRepository.incrementDailyActionCount(userId, actionType, today);
      }

      // Vérifier le cap hebdomadaire
      const weeklyCap = WEEKLY_CAPS[actionType];
      if (weeklyCap !== undefined) {
        // Logique simplifiée pour l'instant: on compte les transactions des 7 derniers jours
        // TODO: Optimiser avec une table dédiée si nécessaire pour la performance
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

        const weeklyCount = await xpRepository.countTransactions(userId, actionType, { since: oneWeekAgo });

        if (weeklyCount >= weeklyCap) {
          logDeduplicator.info('Weekly cap reached for action', { userId, actionType, cap: weeklyCap, weeklyCount });
          return 0;
        }
      }

      // Vérifier les doublons pour les actions avec référence
      if (referenceId) {
        const exists = await xpRepository.transactionExists(userId, actionType, referenceId);
        if (exists) {
          logDeduplicator.info('XP action already granted for this reference', {
            userId, actionType, referenceId
          });
          return 0;
        }
      }

      // Calculer l'XP à attribuer
      const xpAmount = customXpAmount ?? XP_REWARDS[actionType];

      // Créer la transaction XP
      await xpRepository.createTransaction({
        userId,
        actionType,
        xpAmount,
        referenceId,
        description,
      });

      // Mettre à jour le total XP et le niveau de l'utilisateur
      const user = await userRepository.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const newTotalXp = user.totalXp + xpAmount;
      const newLevel = calculateLevel(newTotalXp);

      await xpRepository.updateUserXp(userId, newTotalXp, newLevel);

      // Mettre à jour les weekly challenges
      await this.updateWeeklyChallengeProgress(userId, actionType);

      // Log level up
      if (newLevel > user.level) {
        logDeduplicator.info('User leveled up!', {
          userId,
          oldLevel: user.level,
          newLevel,
          totalXp: newTotalXp
        });
      }

      logDeduplicator.info('XP granted successfully', {
        userId,
        actionType,
        xpAmount,
        newTotalXp,
        newLevel
      });

      return xpAmount;
    } catch (error) {
      logDeduplicator.error('Error granting XP', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        actionType,
      });
      throw error;
    }
  }

  /**
   * Met à jour la progression des weekly challenges basé sur l'action
   */
  private async updateWeeklyChallengeProgress(userId: number, actionType: XpActionType): Promise<void> {
    const today = new Date();

    // Mapping action -> challenge
    const actionToChallengeMap: Partial<Record<XpActionType, WeeklyChallengeType>> = {
      MARK_RESOURCE_READ: 'READ_20_RESOURCES',
      CREATE_READLIST: 'CREATE_5_READLISTS',
      DAILY_LOGIN: 'LOGIN_7_DAYS',
      ADD_WALLET_TO_LIST: 'ADD_15_WALLETS',
    };

    const challengeType = actionToChallengeMap[actionType];
    if (!challengeType) return;

    try {
      // S'assurer que les challenges existent
      await xpRepository.getOrCreateWeeklyChallenges(userId, today);

      // Incrémenter la progression
      const challenge = await xpRepository.incrementChallengeProgress(userId, challengeType, today);

      // Si le challenge vient d'être complété, attribuer l'XP bonus
      if (challenge?.completed && challenge.completedAt) {
        const timeSinceCompletion = Date.now() - challenge.completedAt.getTime();
        // Si complété il y a moins de 1 seconde (vient d'être complété)
        if (timeSinceCompletion < 1000) {
          await this.grantXp({
            userId,
            actionType: 'ADMIN_BONUS',
            customXpAmount: challenge.xpReward,
            referenceId: `weekly-${challengeType}-${challenge.weekStart.toISOString().split('T')[0]}`,
            description: `Weekly challenge completed: ${WEEKLY_CHALLENGES_CONFIG[challengeType].description}`,
          });
          logDeduplicator.info('Weekly challenge completed!', { userId, challengeType, xpReward: challenge.xpReward });
        }
      }
    } catch (error) {
      logDeduplicator.error('Error updating weekly challenge', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        actionType,
      });
    }
  }

  /**
   * Gère le login quotidien et les streaks
   */
  async handleDailyLogin(userId: number): Promise<{
    xpGranted: number;
    streakBonus: number;
    newStreak: number;
    dailyTaskCompleted: boolean;
  }> {
    try {
      const user = await userRepository.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const now = new Date();
      const lastLogin = user.lastLoginAt;
      let newStreak = user.loginStreak;
      let streakBonus = 0;

      // Calculer le streak
      if (lastLogin) {
        const lastLoginDate = new Date(lastLogin);
        lastLoginDate.setHours(0, 0, 0, 0);

        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const daysDiff = Math.floor((today.getTime() - lastLoginDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysDiff === 0) {
          // Déjà connecté aujourd'hui, pas de changement
          return { xpGranted: 0, streakBonus: 0, newStreak, dailyTaskCompleted: false };
        } else if (daysDiff === 1) {
          // Jour consécutif
          newStreak += 1;
        } else {
          // Streak cassé
          newStreak = 1;
        }
      } else {
        // Premier login
        newStreak = 1;
      }

      // Mettre à jour le streak
      await xpRepository.updateLoginStreak(userId, newStreak, now);

      // Attribuer l'XP du login quotidien
      const xpGranted = await this.grantXp({
        userId,
        actionType: 'DAILY_LOGIN',
        referenceId: now.toISOString().split('T')[0], // Date du jour
      });

      // Compléter la daily task LOGIN
      await this.completeDailyTask(userId, 'LOGIN');

      // Vérifier les bonus de streak
      if (newStreak === STREAK_MILESTONES.WEEK) {
        streakBonus = await this.grantXp({
          userId,
          actionType: 'LOGIN_STREAK_7',
          referenceId: `streak-7-${Math.floor(newStreak / STREAK_MILESTONES.WEEK)}`,
        });
      } else if (newStreak === STREAK_MILESTONES.MONTH) {
        streakBonus = await this.grantXp({
          userId,
          actionType: 'LOGIN_STREAK_30',
          referenceId: `streak-30-${Math.floor(newStreak / STREAK_MILESTONES.MONTH)}`,
        });
      }

      logDeduplicator.info('Daily login handled', {
        userId,
        newStreak,
        xpGranted,
        streakBonus
      });

      return { xpGranted, streakBonus, newStreak, dailyTaskCompleted: true };
    } catch (error) {
      logDeduplicator.error('Error handling daily login', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Récupère les statistiques XP d'un utilisateur
   */
  async getUserXpStats(userId: number): Promise<UserXpStats> {
    try {
      const userData = await xpRepository.getUserXpData(userId);
      if (!userData) {
        throw new Error('User not found');
      }

      // S'assurer que totalXp est un nombre valide (pas null/undefined)
      const totalXp = userData.totalXp ?? 0;
      const progress = calculateLevelProgress(totalXp);

      return {
        totalXp: totalXp,
        level: progress.currentLevel, // Utiliser le niveau calculé plutôt que celui de la DB pour cohérence
        currentLevelXp: progress.currentLevelXp,
        nextLevelXp: progress.nextLevelXp,
        progressPercent: progress.progressPercent,
        xpToNextLevel: progress.xpToNextLevel,
        loginStreak: userData.loginStreak ?? 0,
        lastLoginAt: userData.lastLoginAt,
      };
    } catch (error) {
      logDeduplicator.error('Error getting user XP stats', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Récupère l'historique des transactions XP d'un utilisateur
   */
  async getTransactionHistory(
    userId: number,
    options: { page?: number; limit?: number; actionType?: XpActionType }
  ): Promise<XpTransactionHistoryResponse> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);
    const skip = (page - 1) * limit;

    try {
      const [transactions, total] = await Promise.all([
        xpRepository.getTransactionHistory(userId, {
          skip,
          take: limit,
          actionType: options.actionType,
        }),
        xpRepository.countTransactions(userId, options.actionType),
      ]);

      return {
        transactions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logDeduplicator.error('Error getting XP transaction history', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Récupère le leaderboard XP
   */
  async getLeaderboard(options: {
    page?: number;
    limit?: number;
    userId?: number; // Pour récupérer le rang de l'utilisateur actuel
  }): Promise<XpLeaderboardResponse> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);
    const skip = (page - 1) * limit;

    try {
      const [users, total] = await Promise.all([
        xpRepository.getLeaderboard({ skip, take: limit }),
        xpRepository.countUsersWithXp(),
      ]);

      const leaderboard = users.map((user, index) => ({
        rank: skip + index + 1,
        userId: user.id,
        name: user.name,
        totalXp: user.totalXp,
        level: user.level,
      }));

      let userRank: number | undefined;
      if (options.userId) {
        userRank = await xpRepository.getUserRank(options.userId);
      }

      return {
        leaderboard,
        userRank,
        total,
      };
    } catch (error) {
      logDeduplicator.error('Error getting XP leaderboard', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Bonus admin (ajout manuel d'XP)
   */
  async adminGrantXp(
    adminId: number,
    targetUserId: number,
    xpAmount: number,
    description: string
  ): Promise<number> {
    const actionType = xpAmount >= 0 ? 'ADMIN_BONUS' : 'ADMIN_PENALTY';

    logDeduplicator.info('Admin XP grant', {
      adminId,
      targetUserId,
      xpAmount,
      description
    });

    return this.grantXp({
      userId: targetUserId,
      actionType,
      customXpAmount: Math.abs(xpAmount) * (xpAmount >= 0 ? 1 : -1),
      referenceId: `admin-${adminId}-${Date.now()}`,
      description,
    });
  }

  // ==================== DAILY TASKS ====================

  /**
   * Récupère les daily tasks du jour avec leur statut
   */
  async getDailyTasks(userId: number): Promise<{
    tasks: Array<{
      type: DailyTaskType;
      description: string;
      xp: number;
      completed: boolean;
      completedAt: Date | null;
    }>;
    allCompleted: boolean;
    bonusXp: number;
    bonusClaimed: boolean;
  }> {
    const today = new Date();
    const progress = await xpRepository.getDailyTasks(userId, today);

    const taskTypes: DailyTaskType[] = ['LOGIN', 'READ_RESOURCE', 'ADD_WALLET', 'EXPLORE_LEADERBOARD'];

    const tasks = taskTypes.map((type) => {
      const taskProgress = progress.find((p) => p.taskType === type);
      return {
        type,
        description: DAILY_TASKS_CONFIG[type].description,
        xp: DAILY_TASKS_CONFIG[type].xp,
        completed: taskProgress?.completed ?? false,
        completedAt: taskProgress?.completedAt ?? null,
      };
    });

    const completedCount = tasks.filter((t) => t.completed).length;
    const allCompleted = completedCount === taskTypes.length;

    // Vérifier si le bonus a déjà été réclamé
    const bonusRefId = `daily-bonus-${today.toISOString().split('T')[0]}`;
    const bonusClaimed = await xpRepository.transactionExists(userId, 'ADMIN_BONUS', bonusRefId);

    return {
      tasks,
      allCompleted,
      bonusXp: DAILY_COMPLETION_BONUS,
      bonusClaimed,
    };
  }

  /**
   * Complète une daily task et attribue l'XP
   */
  async completeDailyTask(userId: number, taskType: DailyTaskType): Promise<{
    xpGranted: number;
    allTasksCompleted: boolean;
    bonusGranted: number;
  }> {
    const today = new Date();

    // Vérifier si déjà complétée
    const alreadyCompleted = await xpRepository.isDailyTaskCompleted(userId, taskType, today);
    if (alreadyCompleted) {
      return { xpGranted: 0, allTasksCompleted: false, bonusGranted: 0 };
    }

    // Compléter la task
    await xpRepository.completeDailyTask(userId, taskType, today);

    // Attribuer l'XP de la task
    const taskXp = DAILY_TASKS_CONFIG[taskType].xp;
    const xpGranted = await this.grantXp({
      userId,
      actionType: 'ADMIN_BONUS',
      customXpAmount: taskXp,
      referenceId: `daily-task-${taskType}-${today.toISOString().split('T')[0]}`,
      description: `Daily task: ${DAILY_TASKS_CONFIG[taskType].description}`,
    });

    // Vérifier si toutes les tasks sont complétées
    const completedCount = await xpRepository.countCompletedDailyTasks(userId, today);
    const totalTasks = Object.keys(DAILY_TASKS_CONFIG).length;
    const allTasksCompleted = completedCount >= totalTasks;

    let bonusGranted = 0;
    if (allTasksCompleted) {
      // Attribuer le bonus de completion
      bonusGranted = await this.grantXp({
        userId,
        actionType: 'ADMIN_BONUS',
        customXpAmount: DAILY_COMPLETION_BONUS,
        referenceId: `daily-bonus-${today.toISOString().split('T')[0]}`,
        description: 'All daily tasks completed bonus',
      });

      if (bonusGranted > 0) {
        logDeduplicator.info('All daily tasks completed!', { userId, bonusGranted });
      }
    }

    return { xpGranted, allTasksCompleted, bonusGranted };
  }

  // ==================== WEEKLY CHALLENGES ====================

  /**
   * Récupère les weekly challenges de la semaine en cours
   */
  async getWeeklyChallenges(userId: number): Promise<{
    challenges: Array<{
      type: WeeklyChallengeType;
      description: string;
      progress: number;
      target: number;
      progressPercent: number;
      xpReward: number;
      completed: boolean;
      completedAt: Date | null;
    }>;
    weekStart: Date;
    weekEnd: Date;
  }> {
    const today = new Date();
    const challenges = await xpRepository.getOrCreateWeeklyChallenges(userId, today);

    // Calculer le début et la fin de la semaine
    const weekStart = challenges[0]?.weekStart ?? this.getWeekStart(today);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    return {
      challenges: challenges.map((c) => {
        // Protection contre division par zéro et valeurs négatives
        const progress = Math.max(0, c.progress);
        const target = Math.max(1, c.target); // Minimum 1 pour éviter division par zéro
        const progressPercent = Math.min(100, Math.max(0, Math.floor((progress / target) * 100)));
        
        return {
          type: c.challengeType,
          description: WEEKLY_CHALLENGES_CONFIG[c.challengeType].description,
          progress: c.progress,
          target: c.target,
          progressPercent,
          xpReward: c.xpReward,
          completed: c.completed,
          completedAt: c.completedAt,
        };
      }),
      weekStart,
      weekEnd,
    };
  }

  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ==================== DAILY LIMITS ====================

  /**
   * Récupère les limites quotidiennes restantes
   */
  async getDailyLimits(userId: number): Promise<{
    limits: Array<{
      actionType: XpActionType;
      used: number;
      max: number;
      remaining: number;
      xpPerAction: number;
    }>;
  }> {
    const today = new Date();
    const counts = await xpRepository.getAllDailyActionCounts(userId, today);

    const limits = Object.entries(DAILY_CAPS).map(([actionType, max]) => {
      const count = counts.find((c) => c.actionType === actionType);
      const used = count?.count ?? 0;
      return {
        actionType: actionType as XpActionType,
        used,
        max: max as number,
        remaining: Math.max(0, (max as number) - used),
        xpPerAction: XP_REWARDS[actionType as XpActionType],
      };
    });

    return { limits };
  }

  /**
   * Marque une ressource comme explorée (pour la daily task EXPLORE_LEADERBOARD)
   */
  async markLeaderboardExplored(userId: number): Promise<{
    xpGranted: number;
    allTasksCompleted: boolean;
    bonusGranted: number;
  }> {
    return this.completeDailyTask(userId, 'EXPLORE_LEADERBOARD');
  }
}

export const xpService = XpService.getInstance();





