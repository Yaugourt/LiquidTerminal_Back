import { redisService } from '../core/redis.service';
import { logDeduplicator } from './logDeduplicator';

/**
 * Acquire a distributed lock using Redis SET NX EX.
 * Returns true if lock was acquired, false otherwise.
 * Lock auto-expires after `ttlSeconds` to prevent deadlocks.
 */
export async function acquireDistributedLock(lockKey: string, ttlSeconds: number): Promise<boolean> {
  try {
    const redis = redisService.getClient();
    const result = await redis.set(lockKey, process.pid.toString(), 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (error) {
    logDeduplicator.error('Failed to acquire distributed lock', {
      lockKey,
      error: error instanceof Error ? error.message : String(error),
    });
    // On Redis failure, allow polling (better to duplicate than miss data)
    return true;
  }
}

/**
 * Release a distributed lock.
 */
export async function releaseDistributedLock(lockKey: string): Promise<void> {
  try {
    await redisService.delete(lockKey);
  } catch (error) {
    logDeduplicator.error('Failed to release distributed lock', {
      lockKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Execute a function with a distributed lock.
 * If lock cannot be acquired, the function is skipped silently.
 */
export async function withDistributedLock(
  lockKey: string,
  ttlSeconds: number,
  fn: () => Promise<void>
): Promise<boolean> {
  const acquired = await acquireDistributedLock(lockKey, ttlSeconds);
  if (!acquired) {
    return false;
  }

  try {
    await fn();
  } finally {
    await releaseDistributedLock(lockKey);
  }
  return true;
}
