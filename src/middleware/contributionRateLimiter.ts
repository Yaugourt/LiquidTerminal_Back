import { Request, Response, NextFunction } from 'express';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { CONTRIBUTION_LIMITS } from '../constants/content-filter.constants';

/**
 * Rate limiter spécifique aux contributions utilisateur (soumission de ressources wiki)
 * Limite: 5 soumissions par jour par utilisateur
 */

const getRedisKey = (userId: number): string => {
    return `contribution:daily:${userId}`;
};

export const contributionRateLimiter = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        // Récupérer l'ID utilisateur depuis le middleware d'auth
        const userId = req.currentUser?.id;

        if (!userId) {
            res.status(401).json({
                success: false,
                error: 'User not authenticated',
                code: 'UNAUTHENTICATED',
            });
            return;
        }

        const key = getRedisKey(userId);
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - (CONTRIBUTION_LIMITS.WINDOW_MS / 1000);

        const redis = (redisService as any).redisNormal || (redisService as any).redis;

        // Compter les contributions dans les dernières 24h
        const count = await redis.zcount(key, windowStart, '+inf');

        if (count >= CONTRIBUTION_LIMITS.MAX_SUBMISSIONS_PER_DAY) {
            logDeduplicator.warn('Contribution rate limit exceeded', {
                userId,
                count,
                limit: CONTRIBUTION_LIMITS.MAX_SUBMISSIONS_PER_DAY,
            });

            res.status(429).json({
                success: false,
                error: 'Daily submission limit reached',
                code: 'RATE_LIMIT_EXCEEDED',
                details: {
                    limit: CONTRIBUTION_LIMITS.MAX_SUBMISSIONS_PER_DAY,
                    remaining: 0,
                    resetIn: '24 hours',
                },
            });
            return;
        }

        // Ajouter le header avec le nombre restant
        const remaining = CONTRIBUTION_LIMITS.MAX_SUBMISSIONS_PER_DAY - count;
        res.setHeader('X-RateLimit-Limit', CONTRIBUTION_LIMITS.MAX_SUBMISSIONS_PER_DAY);
        res.setHeader('X-RateLimit-Remaining', remaining);

        next();
    } catch (error) {
        logDeduplicator.error('Contribution rate limiter error', { error });
        // En cas d'erreur Redis, on laisse passer la requête
        next();
    }
};

/**
 * Enregistre une contribution réussie pour le tracking rate limit
 */
export const recordContribution = async (userId: number): Promise<void> => {
    try {
        const key = getRedisKey(userId);
        const now = Math.floor(Date.now() / 1000);
        const windowSeconds = CONTRIBUTION_LIMITS.WINDOW_MS / 1000;

        const redis = (redisService as any).redisNormal || (redisService as any).redis;

        // Ajouter la contribution au sorted set
        await redis.zadd(key, now, `${now}:${Math.random()}`);

        // Nettoyer les anciennes entrées
        await redis.zremrangebyscore(key, 0, now - windowSeconds);

        // Définir une expiration sur la clé
        await redis.expire(key, windowSeconds * 2);

        logDeduplicator.info('Contribution recorded for rate limiting', { userId });
    } catch (error) {
        logDeduplicator.error('Error recording contribution', { userId, error });
    }
};

/**
 * Obtient le nombre de soumissions restantes pour un utilisateur
 */
export const getRemainingSubmissions = async (userId: number): Promise<number> => {
    try {
        const key = getRedisKey(userId);
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - (CONTRIBUTION_LIMITS.WINDOW_MS / 1000);

        const redis = (redisService as any).redisNormal || (redisService as any).redis;

        const count = await redis.zcount(key, windowStart, '+inf');
        return Math.max(0, CONTRIBUTION_LIMITS.MAX_SUBMISSIONS_PER_DAY - count);
    } catch (error) {
        logDeduplicator.error('Error getting remaining submissions', { userId, error });
        return CONTRIBUTION_LIMITS.MAX_SUBMISSIONS_PER_DAY; // En cas d'erreur, on suppose le max
    }
};
