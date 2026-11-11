import { randomUUID } from 'node:crypto';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from './logDeduplicator';

/** Deletes the lock only when it is still ours. */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** Pushes the lock's expiry back only when it is still ours. */
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end`;

/** What `acquire` answers when Redis could not be asked: run, with nothing to renew or give back. */
const UNLOCKED = 'unlocked';

export interface LockOptions {
  /**
   * Keep the lock for as long as `fn` runs, by pushing its expiry back every third of its TTL.
   * Without it a run longer than the TTL loses the lock half way, and another process starts
   * the same work beside it. The TTL is then only how long a lock outlives a process that died.
   */
  renew?: boolean;
}

/**
 * Takes `lockKey` for this call (Redis SET NX EX with a token of its own) and
 * returns the token, or null when someone else holds it. When Redis cannot be
 * asked, the answer is 'unlocked': the work runs without a lock, as it always
 * has (a poller that stops because Redis is down misses data; two that run at
 * once only do the work twice, and every write behind these locks is
 * idempotent).
 */
async function acquire(lockKey: string, ttlSeconds: number): Promise<string | null> {
  const token = randomUUID();
  try {
    const result = await redisService.getClient().set(lockKey, token, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? token : null;
  } catch (error) {
    logDeduplicator.error('Failed to acquire distributed lock', {
      lockKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return UNLOCKED;
  }
}

/**
 * Gives the lock back, if it is still ours. The value used to be the process id (1 in every
 * container) and the release an unconditional DEL: a run that outlived its TTL deleted the lock
 * of the process that had taken over, and a third one could then start.
 */
async function release(lockKey: string, token: string): Promise<void> {
  try {
    await redisService.getClient().eval(RELEASE, 1, lockKey, token);
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
  fn: () => Promise<void>,
  options: LockOptions = {}
): Promise<boolean> {
  const token = await acquire(lockKey, ttlSeconds);
  if (token === null) {
    return false;
  }

  let renewal: NodeJS.Timeout | null = null;
  if (options.renew && token !== UNLOCKED) {
    renewal = setInterval(
      () => {
        void Promise.resolve(redisService.getClient().eval(RENEW, 1, lockKey, token, String(ttlSeconds))).catch(() => undefined);
      },
      Math.max(1_000, Math.floor((ttlSeconds * 1000) / 3))
    );
    renewal.unref?.();
  }

  try {
    await fn();
  } finally {
    if (renewal) clearInterval(renewal);
    if (token !== UNLOCKED) await release(lockKey, token);
  }
  return true;
}
