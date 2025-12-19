import { PrismaClient, XpActionType, XpTransaction, User, DailyTaskType, WeeklyChallengeType, DailyTaskProgress, WeeklyChallenge, DailyActionCount } from '@prisma/client';
import { prisma } from '../core/prisma.service';
import { WEEKLY_CHALLENGES_CONFIG } from '../constants/xp.constants';

export class XpRepository {
    private prismaClient: PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'> = prisma;

    /**
     * Crée une transaction XP
     */
    async createTransaction(data: {
        userId: number;
        actionType: XpActionType;
        xpAmount: number;
        referenceId?: string;
        description?: string;
    }): Promise<XpTransaction> {
        return this.prismaClient.xpTransaction.create({
            data: {
                userId: data.userId,
                actionType: data.actionType,
                xpAmount: data.xpAmount,
                referenceId: data.referenceId || null,
                description: data.description || null,
            },
        });
    }

    /**
     * Vérifie si une transaction existe déjà (pour éviter les doublons)
     */
    async transactionExists(
        userId: number,
        actionType: XpActionType,
        referenceId?: string | null
    ): Promise<boolean> {
        // Use findFirst because referenceId is nullable and can't be used in composite unique with null
        const transaction = await this.prismaClient.xpTransaction.findFirst({
            where: {
                userId,
                actionType,
                referenceId: referenceId ?? null,
            },
        });
        return !!transaction;
    }

    /**
     * Vérifie si une action quotidienne a déjà été effectuée aujourd'hui
     */
    async hasDailyAction(userId: number, actionType: XpActionType): Promise<boolean> {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const transaction = await this.prismaClient.xpTransaction.findFirst({
            where: {
                userId,
                actionType,
                createdAt: {
                    gte: today,
                    lt: tomorrow,
                },
            },
        });
        return !!transaction;
    }

    /**
     * Met à jour l'XP et le niveau d'un utilisateur
     */
    async updateUserXp(
        userId: number,
        totalXp: number,
        level: number
    ): Promise<User> {
        return this.prismaClient.user.update({
            where: { id: userId },
            data: { totalXp, level },
        });
    }

    /**
     * Met à jour le login streak d'un utilisateur
     */
    async updateLoginStreak(
        userId: number,
        loginStreak: number,
        lastLoginAt: Date
    ): Promise<User> {
        return this.prismaClient.user.update({
            where: { id: userId },
            data: { loginStreak, lastLoginAt },
        });
    }

    /**
     * Récupère l'historique des transactions XP d'un utilisateur
     */
    async getTransactionHistory(
        userId: number,
        options: {
            skip?: number;
            take?: number;
            actionType?: XpActionType;
        }
    ): Promise<XpTransaction[]> {
        return this.prismaClient.xpTransaction.findMany({
            where: {
                userId,
                ...(options.actionType && { actionType: options.actionType }),
            },
            orderBy: { createdAt: 'desc' },
            skip: options.skip,
            take: options.take,
        });
    }

    /**
     * Compte le nombre de transactions XP d'un utilisateur
     */
    async countTransactions(
        userId: number,
        actionType?: XpActionType,
        options?: { since?: Date }
    ): Promise<number> {
        return this.prismaClient.xpTransaction.count({
            where: {
                userId,
                ...(actionType && { actionType }),
                ...(options?.since && {
                    createdAt: {
                        gte: options.since,
                    },
                }),
            },
        });
    }

    /**
     * Récupère le leaderboard XP
     */
    async getLeaderboard(options: {
        skip?: number;
        take?: number;
    }): Promise<Pick<User, 'id' | 'name' | 'totalXp' | 'level'>[]> {
        return this.prismaClient.user.findMany({
            where: {
                totalXp: { gt: 0 },
            },
            select: {
                id: true,
                name: true,
                totalXp: true,
                level: true,
            },
            orderBy: { totalXp: 'desc' },
            skip: options.skip,
            take: options.take,
        });
    }

    /**
     * Compte le nombre d'utilisateurs avec XP > 0
     */
    async countUsersWithXp(): Promise<number> {
        return this.prismaClient.user.count({
            where: { totalXp: { gt: 0 } },
        });
    }

    /**
     * Récupère le rang d'un utilisateur dans le leaderboard
     */
    async getUserRank(userId: number): Promise<number> {
        const user = await this.prismaClient.user.findUnique({
            where: { id: userId },
            select: { totalXp: true },
        });

        if (!user) return 0;

        const rank = await this.prismaClient.user.count({
            where: { totalXp: { gt: user.totalXp } },
        });

        return rank + 1;
    }

    /**
     * Récupère les stats XP d'un utilisateur
     */
    async getUserXpData(userId: number): Promise<Pick<User, 'totalXp' | 'level' | 'loginStreak' | 'lastLoginAt'> | null> {
        return this.prismaClient.user.findUnique({
            where: { id: userId },
            select: {
                totalXp: true,
                level: true,
                loginStreak: true,
                lastLoginAt: true,
            },
        });
    }

    // ==================== DAILY ACTION COUNTS (CAPS) ====================

    /**
     * Récupère le compteur d'actions du jour pour un type donné
     */
    async getDailyActionCount(userId: number, actionType: XpActionType, date: Date): Promise<number> {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        const record = await this.prismaClient.dailyActionCount.findUnique({
            where: {
                userId_actionType_date: {
                    userId,
                    actionType,
                    date: dateOnly,
                },
            },
        });
        return record?.count ?? 0;
    }

    /**
     * Incrémente le compteur d'actions du jour
     */
    async incrementDailyActionCount(userId: number, actionType: XpActionType, date: Date): Promise<DailyActionCount> {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        return this.prismaClient.dailyActionCount.upsert({
            where: {
                userId_actionType_date: {
                    userId,
                    actionType,
                    date: dateOnly,
                },
            },
            update: {
                count: { increment: 1 },
            },
            create: {
                userId,
                actionType,
                date: dateOnly,
                count: 1,
            },
        });
    }

    /**
     * Récupère tous les compteurs du jour pour un utilisateur
     */
    async getAllDailyActionCounts(userId: number, date: Date): Promise<DailyActionCount[]> {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        return this.prismaClient.dailyActionCount.findMany({
            where: {
                userId,
                date: dateOnly,
            },
        });
    }

    // ==================== DAILY TASKS ====================

    /**
     * Récupère les daily tasks du jour pour un utilisateur
     */
    async getDailyTasks(userId: number, date: Date): Promise<DailyTaskProgress[]> {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        return this.prismaClient.dailyTaskProgress.findMany({
            where: {
                userId,
                date: dateOnly,
            },
        });
    }

    /**
     * Complète une daily task
     */
    async completeDailyTask(userId: number, taskType: DailyTaskType, date: Date): Promise<DailyTaskProgress> {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        return this.prismaClient.dailyTaskProgress.upsert({
            where: {
                userId_taskType_date: {
                    userId,
                    taskType,
                    date: dateOnly,
                },
            },
            update: {
                completed: true,
                completedAt: new Date(),
            },
            create: {
                userId,
                taskType,
                date: dateOnly,
                completed: true,
                completedAt: new Date(),
            },
        });
    }

    /**
     * Vérifie si une daily task est déjà complétée
     */
    async isDailyTaskCompleted(userId: number, taskType: DailyTaskType, date: Date): Promise<boolean> {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        const task = await this.prismaClient.dailyTaskProgress.findUnique({
            where: {
                userId_taskType_date: {
                    userId,
                    taskType,
                    date: dateOnly,
                },
            },
        });
        return task?.completed ?? false;
    }

    /**
     * Compte les daily tasks complétées aujourd'hui
     */
    async countCompletedDailyTasks(userId: number, date: Date): Promise<number> {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        return this.prismaClient.dailyTaskProgress.count({
            where: {
                userId,
                date: dateOnly,
                completed: true,
            },
        });
    }

    // ==================== WEEKLY CHALLENGES ====================

    /**
     * Obtient le lundi de la semaine pour une date
     */
    private getWeekStart(date: Date): Date {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Lundi
        d.setDate(diff);
        d.setHours(0, 0, 0, 0);
        return new Date(d.toISOString().split('T')[0]);
    }

    /**
     * Récupère ou crée les challenges de la semaine
     */
    async getOrCreateWeeklyChallenges(userId: number, date: Date): Promise<WeeklyChallenge[]> {
        const weekStart = this.getWeekStart(date);

        const existing = await this.prismaClient.weeklyChallenge.findMany({
            where: {
                userId,
                weekStart,
            },
        });

        // Si les challenges existent déjà, les retourner
        if (existing.length > 0) {
            return existing;
        }

        // Sinon, créer tous les challenges de la semaine
        const challengeTypes: WeeklyChallengeType[] = [
            'READ_20_RESOURCES',
            'CREATE_5_READLISTS',
            'LOGIN_7_DAYS',
            'ADD_15_WALLETS',
        ];

        const challenges = await Promise.all(
            challengeTypes.map((challengeType) =>
                this.prismaClient.weeklyChallenge.create({
                    data: {
                        userId,
                        challengeType,
                        weekStart,
                        target: WEEKLY_CHALLENGES_CONFIG[challengeType].target,
                        xpReward: WEEKLY_CHALLENGES_CONFIG[challengeType].xp,
                        progress: 0,
                        completed: false,
                    },
                })
            )
        );

        return challenges;
    }

    /**
     * Incrémente la progression d'un challenge
     */
    async incrementChallengeProgress(
        userId: number,
        challengeType: WeeklyChallengeType,
        date: Date,
        increment: number = 1
    ): Promise<WeeklyChallenge | null> {
        const weekStart = this.getWeekStart(date);

        const challenge = await this.prismaClient.weeklyChallenge.findUnique({
            where: {
                userId_challengeType_weekStart: {
                    userId,
                    challengeType,
                    weekStart,
                },
            },
        });

        if (!challenge || challenge.completed) {
            return challenge;
        }

        const newProgress = Math.min(challenge.progress + increment, challenge.target);
        const isCompleted = newProgress >= challenge.target;

        return this.prismaClient.weeklyChallenge.update({
            where: { id: challenge.id },
            data: {
                progress: newProgress,
                completed: isCompleted,
                completedAt: isCompleted ? new Date() : null,
            },
        });
    }

    /**
     * Récupère les challenges de la semaine
     */
    async getWeeklyChallenges(userId: number, date: Date): Promise<WeeklyChallenge[]> {
        const weekStart = this.getWeekStart(date);

        return this.prismaClient.weeklyChallenge.findMany({
            where: {
                userId,
                weekStart,
            },
        });
    }
}

export const xpRepository = new XpRepository();

