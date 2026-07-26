import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { EXPORT_LIMITS, EXPORT_PREVIEW_LIMITS } from '../constants/export.constants';

/**
 * Per-user quota for CSV exports.
 *
 * Reserve-then-release rather than check-then-record: an export streams for
 * many seconds, and a plain "count, then record at the end" leaves that whole
 * window open — N concurrent requests all read 0 used and all succeed, which
 * turns a quota of one into a quota of N.
 *
 * So the slot is claimed up front and released if the download does not
 * complete. Ordering is decided by ZRANK, which is what makes it race-free:
 * however many requests add themselves at once, exactly `limit` of them hold a
 * rank below the limit, and the rest withdraw.
 *
 * The release path is what keeps the quota honest in the other direction: a
 * download killed by an upstream 402 or a client disconnect costs nothing,
 * because with a limit of one a charged failure is indistinguishable from a
 * broken feature.
 */

const getRedisKey = (userId: number): string => `export:daily:${userId}`;

export const exportRateLimiter = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
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
        const windowSeconds = EXPORT_LIMITS.WINDOW_MS / 1000;
        const windowStart = now - windowSeconds;

        const redis = redisService.getClient();

        // Claim a slot, then let ZRANK decide whether it was within the limit.
        const reservation = `${now}:${randomUUID()}`;
        await redis.zadd(key, now, reservation);
        await redis.zremrangebyscore(key, 0, windowStart);
        await redis.expire(key, windowSeconds * 2);

        const rank = await redis.zrank(key, reservation);
        const withinLimit = rank !== null && rank < EXPORT_LIMITS.MAX_EXPORTS_PER_DAY;

        if (!withinLimit) {
            await redis.zrem(key, reservation);
            const count = await redis.zcount(key, windowStart, '+inf');
            // Oldest export still inside the window decides when a slot frees up.
            const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
            const oldestAt = oldest.length >= 2 ? Number(oldest[1]) : now;
            const resetInSeconds = Math.max(0, oldestAt + windowSeconds - now);

            logDeduplicator.warn('Export rate limit exceeded', {
                userId,
                count,
                limit: EXPORT_LIMITS.MAX_EXPORTS_PER_DAY,
            });

            res.status(429).json({
                success: false,
                error: 'Export limit reached',
                code: 'EXPORT_LIMIT_EXCEEDED',
                details: {
                    limit: EXPORT_LIMITS.MAX_EXPORTS_PER_DAY,
                    remaining: 0,
                    resetInSeconds,
                },
            });
            return;
        }

        // Handed to the route so it can release the slot if the file never lands.
        req.exportReservation = reservation;

        res.setHeader('X-RateLimit-Limit', EXPORT_LIMITS.MAX_EXPORTS_PER_DAY);
        res.setHeader('X-RateLimit-Remaining', EXPORT_LIMITS.MAX_EXPORTS_PER_DAY - (rank + 1));

        next();
    } catch (error) {
        logDeduplicator.error('Export rate limiter error', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
        });
        // Fail-secure: an unreadable counter must not become an open door.
        res.status(503).json({
            success: false,
            error: 'Service temporarily unavailable',
            code: 'SERVICE_UNAVAILABLE',
        });
    }
};

/**
 * Confirms a completed export. The slot is already held, so this only logs —
 * keeping the call site symmetrical with releaseExport.
 */
export const recordExport = async (userId: number, datasetId: string): Promise<void> => {
    logDeduplicator.info('Export confirmed', { userId, datasetId });
};

/**
 * Gives the slot back when the download did not complete.
 *
 * Deliberately best-effort: failing to release costs the user one export for a
 * day, while failing closed on a Redis error would be worse.
 */
export const releaseExport = async (userId: number, reservation?: string): Promise<void> => {
    if (!reservation) return;
    try {
        await redisService.getClient().zrem(getRedisKey(userId), reservation);
        logDeduplicator.info('Export reservation released', { userId });
    } catch (error) {
        logDeduplicator.error('Error releasing export reservation', {
            userId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};

/**
 * Budget for the free preview endpoint.
 *
 * Separate from the export quota and deliberately looser: a preview returns 5
 * rows, but it still costs one call to a paid provider, so it cannot stay
 * unmetered. Counted after the fact rather than reserved — a preview is cheap
 * enough that a lost one does not matter, and the simpler path is worth more
 * here than exactness.
 */
export const exportPreviewRateLimiter = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const userId = req.currentUser?.id;
        if (!userId) {
            res.status(401).json({
                success: false,
                error: 'User not authenticated',
                code: 'UNAUTHENTICATED',
            });
            return;
        }

        const key = `export:preview:${userId}`;
        const now = Math.floor(Date.now() / 1000);
        const windowSeconds = EXPORT_PREVIEW_LIMITS.WINDOW_MS / 1000;

        const redis = redisService.getClient();
        await redis.zadd(key, now, `${now}:${randomUUID()}`);
        await redis.zremrangebyscore(key, 0, now - windowSeconds);
        await redis.expire(key, windowSeconds * 2);
        const count = await redis.zcard(key);

        if (count > EXPORT_PREVIEW_LIMITS.MAX_PREVIEWS_PER_WINDOW) {
            logDeduplicator.warn('Export preview limit exceeded', { userId, count });
            res.status(429).json({
                success: false,
                error: 'Too many previews, try again later',
                code: 'EXPORT_PREVIEW_LIMIT_EXCEEDED',
                details: { limit: EXPORT_PREVIEW_LIMITS.MAX_PREVIEWS_PER_WINDOW },
            });
            return;
        }

        next();
    } catch (error) {
        logDeduplicator.error('Export preview rate limiter error', {
            error: error instanceof Error ? error.message : String(error),
        });
        // Fail-secure, like the export limiter: an unreadable counter must not
        // become an open tap on a paid provider.
        res.status(503).json({
            success: false,
            error: 'Service temporarily unavailable',
            code: 'SERVICE_UNAVAILABLE',
        });
    }
};

export interface ExportQuota {
    limit: number;
    remaining: number;
    /** Seconds until the oldest export leaves the window; 0 when nothing is pending. */
    resetInSeconds: number;
}

/** Quota state for the UI, so the button can say what it will cost before the click. */
export const getExportQuota = async (userId: number): Promise<ExportQuota> => {
    const limit = EXPORT_LIMITS.MAX_EXPORTS_PER_DAY;
    try {
        const key = getRedisKey(userId);
        const now = Math.floor(Date.now() / 1000);
        const windowSeconds = EXPORT_LIMITS.WINDOW_MS / 1000;

        const redis = redisService.getClient();
        const count = await redis.zcount(key, now - windowSeconds, '+inf');
        const remaining = Math.max(0, limit - count);

        let resetInSeconds = 0;
        if (remaining === 0) {
            const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
            const oldestAt = oldest.length >= 2 ? Number(oldest[1]) : now;
            resetInSeconds = Math.max(0, oldestAt + windowSeconds - now);
        }

        return { limit, remaining, resetInSeconds };
    } catch (error) {
        logDeduplicator.error('Error reading export quota', {
            userId,
            error: error instanceof Error ? error.message : String(error),
        });
        // Read-only path: report the quota as spent rather than promise an
        // export the limiter would then refuse.
        return { limit, remaining: 0, resetInSeconds: 0 };
    }
};

declare global {
    namespace Express {
        interface Request {
            /** Quota slot held by this export; released if the file never lands. */
            exportReservation?: string;
        }
    }
}
