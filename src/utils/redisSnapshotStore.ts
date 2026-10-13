import { promisify } from 'util';
import { gunzip, gzip } from 'zlib';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from './logDeduplicator';
import type { SnapshotStore } from './onDemandSnapshot';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const fetchedAtKey = (key: string): string => `${key}:at`;

export interface RedisSnapshotStoreOptions<T, S> {
  /** Seconds Redis keeps the value (the longest it may be served stale). */
  ttlS: number;
  /** Gzip + base64 the JSON: for views of hundreds of KB to MBs. */
  compress?: boolean;
  /** What is stored for a value (drop derived indexes), and how to rebuild it. */
  encode?: (value: T) => S;
  decode?: (stored: S) => T;
}

/**
 * An OnDemandSnapshot store in one Redis key: `{ fetchedAt, value }` as JSON,
 * optionally gzipped, and the fetch time alone in `${key}:at` (same TTL), so
 * a refresh can tell whether the stored value is newer before it pulls and
 * decodes MBs of it. A missing, unreadable or corrupt entry reads as null.
 */
export function redisSnapshotStore<T, S = T>(
  key: string,
  options: RedisSnapshotStoreOptions<T, S>
): SnapshotStore<T> {
  return {
    async loadFetchedAt() {
      const raw = await redisService.get(fetchedAtKey(key));
      const at = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(at) ? at : null;
    },
    async load() {
      const raw = await redisService.get(key);
      if (!raw) return null;
      try {
        const json = options.compress ? (await gunzipAsync(Buffer.from(raw, 'base64'))).toString('utf8') : raw;
        const parsed = JSON.parse(json) as { fetchedAt?: unknown; value?: S };
        if (typeof parsed.fetchedAt !== 'number' || parsed.value === undefined) return null;
        const value = options.decode ? options.decode(parsed.value) : (parsed.value as unknown as T);
        return { value, fetchedAt: parsed.fetchedAt };
      } catch (error) {
        logDeduplicator.warn('Unreadable stored snapshot', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    async save(value, fetchedAt) {
      try {
        const json = JSON.stringify({ fetchedAt, value: options.encode ? options.encode(value) : value });
        const payload = options.compress ? (await gzipAsync(json)).toString('base64') : json;
        await redisService.set(key, payload, options.ttlS);
        await redisService.set(fetchedAtKey(key), String(fetchedAt), options.ttlS);
      } catch (error) {
        logDeduplicator.warn('Failed to store snapshot', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
