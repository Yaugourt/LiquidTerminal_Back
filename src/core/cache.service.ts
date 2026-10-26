import { redisService } from './redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { CACHE_TTL } from '../constants/cache.constants';
import { positiveIntEnv } from '../utils/env';
import { isCallerRefusal } from '../errors/upstreamBudget.errors';
import { upstreamRefusal } from '../utils/request-context';

/** What a recomputation produced, and the JSON it stored when it could. */
interface Recomputed<T> {
  data: T;
  serialized?: string;
}

/**
 * Seconds to keep an entry: a constant, or a function of the value fetched
 * (e.g. keep an empty upstream answer longer than a busy one).
 */
export type CacheTtl<T> = number | ((data: T) => number);

/** A read and whether it is an old copy of the key's last value. */
export interface CacheRead<T> {
  data: T;
  /**
   * True when the value served is the key's last copy and older than its TTL
   * (plus a few seconds): a refresh failed, was skipped after a recent
   * failure, or did not land in time.
   */
  stale: boolean;
}

export interface GetOrSetOptions {
  /**
   * Keep a copy of the last value past the TTL (default true): served when a
   * refresh fails, and while a live key refreshes in the background.
   */
  lastCopy?: boolean;
  /**
   * Serve a live key's last copy while it refreshes (default true). False:
   * every miss waits for the fetch and the copy is only served when it fails,
   * for keys read together that must come from close snapshots (pages of
   * one walk).
   */
  staleWhileRevalidate?: boolean;
  /**
   * Keep the last copy at least this long (seconds, at most a week), so an
   * upstream outage of that length still shows the last value. Opt-in, for
   * shared keys of bounded cardinality only (fixed names or a few params):
   * by default a copy lives about 10 TTLs, at most CACHE_LAST_COPY_MAX_S.
   */
  lastCopyKeepS?: number;
  /**
   * Serve the last copy while one refresh runs even though the TTL is over
   * LIVE_TTL_MAX_S: for slow upstreams nobody should wait on.
   */
  refreshInBackground?: boolean;
}

/** The long-lived copy of a key's last value (`${key}:last`). */
interface LastCopy<T> {
  /** Epoch ms of the fetch that produced it. */
  at: number;
  /** TTL it was stored with, in seconds. */
  ttl: number;
  value: T;
}

/**
 * Keys stored for this long or less are live data: once one expires, a single
 * refresh runs and readers wait for it at most LIVE_REFRESH_WAIT_MS before
 * they get the last copy.
 */
export const LIVE_TTL_MAX_S = 30;
/**
 * How long a reader of an expired live key waits for its refresh (started or
 * joined) before it gets the last copy. Without the wait a key read by one
 * viewer (a wallet's fills, a quiet coin) was always one fetch behind: that
 * viewer saw data up to two TTLs plus a poll old. With it, about one TTL plus
 * a poll, and nobody waits longer than this on a slow upstream.
 */
const LIVE_REFRESH_WAIT_MS = positiveIntEnv('CACHE_LIVE_REFRESH_WAIT_MS', 1_500);
/** A live key's copy is served (after the wait above) until it is this many TTLs old (and at least SWR_MIN_S). */
const SWR_TTL_MULTIPLE = 4;
const SWR_MIN_S = 60;
/** A copy older than its TTL plus this is flagged stale. */
const STALE_MARGIN_MS = 5_000;
/**
 * After a failed fetch, a key that has a last copy is not fetched again for
 * its TTL, at most this long, by any instance (`${key}:fail`): an upstream
 * answering errors fast would otherwise get one attempt per request.
 */
const FAILURE_BACKOFF_MAX_S = 10;

/**
 * How long a key's last copy outlives it. Every key gets one, including keys
 * whose names change all the time (per wallet, per caller-chosen params), so
 * by default it is short: 10 TTLs, capped at CACHE_LAST_COPY_MAX_S (default
 * 10 min) or 2 TTLs if longer, and for a live key at least its
 * stale-while-revalidate window. A value is then kept ~10× longer than its
 * key at most, not hundreds of times. Long outage resilience is opt-in per
 * key (`lastCopyKeepS`, e.g. SHARED_LAST_COPY_KEEP_S).
 */
const LAST_COPY_DEFAULT_MAX_S = positiveIntEnv('CACHE_LAST_COPY_MAX_S', 600);
const LAST_COPY_TTL_MULTIPLE = 10;
const LAST_COPY_ABSOLUTE_MAX_S = 7 * 86_400;
/**
 * A copy kept by default is skipped above this size (serialized characters),
 * unless the key is live (its copy is what spares visitors the wait on
 * expiry) or opted in to a longer keep. A skipped copy deletes the older one.
 */
const LAST_COPY_MAX_CHARS = positiveIntEnv('CACHE_LAST_COPY_MAX_CHARS', 256 * 1024);
/**
 * Keep for shared, bounded-cardinality keys that should survive a long
 * upstream outage (dashboard tiles, global lists): an hour by default.
 */
export const SHARED_LAST_COPY_KEEP_S = positiveIntEnv('CACHE_SHARED_LAST_COPY_S', 3_600);

const lastCopyKey = (key: string): string => `${key}:last`;
const failMarkerKey = (key: string): string => `${key}:fail`;

/** Seconds to keep a copy of a value stored for `ttlS` seconds (see above). */
export function lastCopyKeepS(ttlS: number, live: boolean, optInS?: number): number {
  let keep = Math.min(ttlS * LAST_COPY_TTL_MULTIPLE, Math.max(LAST_COPY_DEFAULT_MAX_S, ttlS * 2));
  if (live) keep = Math.max(keep, swrWindowMs(ttlS) / 1000);
  if (optInS !== undefined && Number.isFinite(optInS)) keep = Math.max(keep, Math.ceil(optInS));
  return Math.min(LAST_COPY_ABSOLUTE_MAX_S, keep);
}

/**
 * A fetchFn failure, as opposed to a failure of the cache itself: the first
 * may be answered with the last copy, never by calling fetchFn again.
 */
class FetchFailure extends Error {
  constructor(public readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'FetchFailure';
  }
}

async function runFetch<T>(fetchFn: () => Promise<T>): Promise<T> {
  try {
    return await fetchFn();
  } catch (error) {
    throw new FetchFailure(error);
  }
}

/**
 * Whole seconds, at least 1: a 0 TTL would store the key without expiry. A
 * throwing TTL function falls back to the default rather than failing a fetch
 * that already succeeded (and paid for its upstream call).
 */
function resolveTtl<T>(ttl: CacheTtl<T>, data: T): number {
  let seconds: number;
  try {
    seconds = typeof ttl === 'function' ? ttl(data) : ttl;
  } catch {
    return CACHE_TTL.MEDIUM;
  }
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : CACHE_TTL.MEDIUM;
}

/**
 * Service de gestion du cache
 * Encapsule la logique de cache utilisée dans les services
 */
export class CacheService {
  /**
   * Misses being recomputed by this process, by key. The Redis lock below
   * only made concurrent misses poll for 600 ms and then call fetchFn
   * themselves, so a slow fetchFn still ran once per waiting request.
   */
  private readonly recomputing = new Map<string, Promise<Recomputed<unknown>>>();
  /**
   * Direct fetches by key while Redis can't be used (circuit open, cache
   * error): still one upstream call per key in this process, not one per
   * request.
   */
  private readonly directFetches = new Map<string, Promise<Recomputed<unknown>>>();

  /**
   * Récupère une donnée du cache ou l'obtient via une fonction de récupération
   * @param key Clé de cache
   * @param fetchFn Fonction pour récupérer la donnée si elle n'est pas en cache
   * @param ttl Durée de vie du cache en secondes, ou fonction de la donnée récupérée
   * @returns La donnée du cache ou celle récupérée par fetchFn
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl: CacheTtl<T> = CACHE_TTL.MEDIUM,
    options: GetOrSetOptions = {}
  ): Promise<T> {
    return (await this.getOrSetWithMeta(key, fetchFn, ttl, options)).data;
  }

  /**
   * getOrSet, telling whether the value is an old copy (for routes that can
   * flag it to the client).
   *
   * - Hit: the stored value.
   * - Miss: one fetchFn per key in this process (concurrent misses share it)
   *   and across instances (Redis lock). Every success also refreshes the
   *   key's last copy (about 10 TTLs, at most 10 min by default; longer with
   *   `lastCopyKeepS`).
   * - Miss on a live key (TTL ≤ LIVE_TTL_MAX_S) whose last copy is recent (4
   *   TTLs, at least a minute): one refresh runs (started or joined), and
   *   readers wait for it at most LIVE_REFRESH_WAIT_MS before they get the
   *   copy. A `refreshInBackground` key serves its copy without waiting.
   * - fetchFn throws (upstream error, open breaker, budget refusal…): the last
   *   copy is served (`stale: true`); without one the error goes to every
   *   caller sharing that fetch. fetchFn is never called a second time, and
   *   while a copy exists the key is not fetched again for a few seconds
   *   (FAILURE_BACKOFF_MAX_S).
   * - Redis unusable: fetchFn, one call per key at a time in this process.
   * - A caller already over its budget of billed upstream calls when its
   *   request came in (see request-context) never starts a recompute or a
   *   refresh: it gets a hit, joins one already running here, or is served the
   *   key's last copy (`stale: true`), else its refusal. Nothing is written
   *   for it, no ":fail" marker included. Callers within budget are never
   *   refused, whatever the recompute makes of their counter.
   */
  async getOrSetWithMeta<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl: CacheTtl<T> = CACHE_TTL.MEDIUM,
    options: GetOrSetOptions = {}
  ): Promise<CacheRead<T>> {
    // Redis unhealthy (circuit open) → skip the cache entirely and serve from
    // source. Without this a wedged Redis connection would stall every request
    // through the get → lock → get → set path until the edge returns 502.
    if (!redisService.isHealthy()) {
      return { data: await this.directFetch(key, fetchFn), stale: false };
    }
    const keepLastCopy = options.lastCopy !== false;
    try {
      const cachedData = await redisService.get(key);
      if (cachedData) {
        return { data: JSON.parse(cachedData), stale: false };
      }

      // The copy is only read here when it may be served now (a long-TTL key
      // waits for its fetch: no need to pull a possibly large copy).
      const mayServeCopy =
        options.staleWhileRevalidate !== false &&
        (options.refreshInBackground === true || typeof ttl === 'function' || ttl <= LIVE_TTL_MAX_S);
      let last: LastCopy<T> | null | undefined;
      if (keepLastCopy && mayServeCopy) {
        last = await this.readLastCopy<T>(key);
        const live = last !== null && last.ttl <= LIVE_TTL_MAX_S;
        const swr = live || (last !== null && options.refreshInBackground === true);
        if (last && swr && Date.now() - last.at <= swrWindowMs(last.ttl)) {
          const refresh = await this.startRefresh(key, fetchFn, ttl, options);
          // A live key waits a moment for it (see LIVE_REFRESH_WAIT_MS).
          const fresh = refresh && live ? await settledWithin(refresh.done, LIVE_REFRESH_WAIT_MS) : undefined;
          if (fresh) return { data: copyOf(fresh), stale: false };
          return { data: last.value, stale: isOldCopy(last) };
        }
      }

      // A fetch of this key failed moments ago (here or on another instance)
      // and a copy exists: serve it rather than ask the upstream again.
      if (keepLastCopy && !this.recomputing.has(key) && (await this.recentlyFailed(key))) {
        if (last === undefined) last = await this.readLastCopy<T>(key);
        if (last) return { data: last.value, stale: true };
      }

      try {
        return { data: await this.sharedRecompute(key, fetchFn, ttl, options), stale: false };
      } catch (error) {
        if (!(error instanceof FetchFailure)) throw error;
        // Re-read: another instance may have stored a newer copy meanwhile.
        const latest = keepLastCopy ? await this.readLastCopy<T>(key) : null;
        if (!latest) throw error;
        // A caller's refusal is not a failure of the fetch: nothing to warn about.
        if (!isCallerRefusal(error.original)) {
          logDeduplicator.warn('Fetch failed, serving the last cached value', {
            key,
            ageS: Math.round((Date.now() - latest.at) / 1000),
            errorMessage: error.message,
          });
        }
        return { data: latest.value, stale: true };
      }
    } catch (error) {
      // fetchFn failed and nothing older can stand in: its error, as is.
      if (error instanceof FetchFailure) throw error.original;
      // The cache itself failed (lock, corrupt entry): serve from source.
      logDeduplicator.warn('Cache error, falling back to direct fetch', {
        key,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
      return { data: await this.directFetch(key, fetchFn), stale: false };
    }
  }

  /** fetchFn without the cache, shared by concurrent callers of the key in this process. */
  private async directFetch<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
    const inflight = this.directFetches.get(key) as Promise<Recomputed<T>> | undefined;
    if (inflight) return copyOf(await inflight);

    // Nothing to serve instead here (no Redis, so no last copy): an over-budget caller is refused.
    const refusal = upstreamRefusal();
    if (refusal) throw refusal;

    const fetching = (async (): Promise<Recomputed<T>> => {
      const data = await fetchFn();
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(data);
      } catch {
        serialized = undefined;
      }
      return { data, serialized };
    })();
    this.directFetches.set(key, fetching);
    try {
      return (await fetching).data;
    } finally {
      if (this.directFetches.get(key) === fetching) this.directFetches.delete(key);
    }
  }

  /** One recomputation per key in this process; followers get a copy of what was stored. */
  private async sharedRecompute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl: CacheTtl<T>,
    options: GetOrSetOptions
  ): Promise<T> {
    // Already being recomputed here: share it. Like the lock waiters, get a
    // copy of what was stored rather than the object handed to the first caller.
    const inflight = this.recomputing.get(key) as Promise<Recomputed<T>> | undefined;
    if (inflight) {
      const { data, serialized } = await inflight;
      return serialized !== undefined ? JSON.parse(serialized) : data;
    }

    // Starting the recompute is what an over-budget caller may not do. Thrown
    // as a FetchFailure so the caller above serves the last copy when there is
    // one; it sits outside fetchOrMarkFailed, so no ":fail" marker is written.
    const refusal = upstreamRefusal();
    if (refusal) throw new FetchFailure(refusal);

    const recomputation = this.track(key, this.recompute(key, fetchFn, ttl, options));
    return (await recomputation).data;
  }

  /**
   * The key's refresh in this process, started unless one runs already.
   * Null when a fetch of the key failed moments ago: the copy is served
   * without asking the upstream again (FAILURE_BACKOFF_MAX_S). Wrapped so
   * the caller decides how long to wait for it.
   */
  private async startRefresh<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl: CacheTtl<T>,
    options: GetOrSetOptions
  ): Promise<{ done: Promise<Recomputed<T>> } | null> {
    const running = this.recomputing.get(key) as Promise<Recomputed<T>> | undefined;
    if (running) return { done: running };
    // An over-budget caller is served the copy and leaves the refresh to the
    // next visitor (who is within budget).
    if (upstreamRefusal()) return null;
    if (await this.recentlyFailed(key)) return null;
    // Started by another caller during the check.
    const joined = this.recomputing.get(key) as Promise<Recomputed<T>> | undefined;
    if (joined) return { done: joined };

    const done = this.track(key, this.recompute(key, fetchFn, ttl, options));
    done.catch((error: unknown) => {
      logDeduplicator.warn('Background cache refresh failed', {
        key,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
    return { done };
  }

  private async recentlyFailed(key: string): Promise<boolean> {
    return (await redisService.get(failMarkerKey(key))) !== null;
  }

  /** Remembers a failed fetch for every instance (see FAILURE_BACKOFF_MAX_S). */
  private async markFailed<T>(key: string, ttl: CacheTtl<T>): Promise<void> {
    const seconds = typeof ttl === 'number' && Number.isFinite(ttl)
      ? Math.min(FAILURE_BACKOFF_MAX_S, Math.max(1, Math.ceil(ttl)))
      : FAILURE_BACKOFF_MAX_S;
    await redisService.set(failMarkerKey(key), '1', seconds);
  }

  /**
   * fetchFn, remembering a failure (FetchFailure) for the backoff. Not a
   * caller's own refusal: the upstream is fine, and a marker would have every
   * other visitor of the key served the last copy (or the error) for the
   * backoff because one client spent its budget.
   */
  private async fetchOrMarkFailed<T>(key: string, fetchFn: () => Promise<T>, ttl: CacheTtl<T>): Promise<T> {
    try {
      return await runFetch(fetchFn);
    } catch (error) {
      if (!(error instanceof FetchFailure && isCallerRefusal(error.original))) {
        await this.markFailed(key, ttl);
      }
      throw error;
    }
  }

  /** Registers a recomputation as the key's in-flight one until it settles. */
  private track<T>(key: string, recomputation: Promise<Recomputed<T>>): Promise<Recomputed<T>> {
    this.recomputing.set(key, recomputation);
    void recomputation
      .finally(() => {
        if (this.recomputing.get(key) === recomputation) {
          this.recomputing.delete(key);
        }
      })
      .catch(() => undefined);
    return recomputation;
  }

  /** Cache miss path, coordinated across instances by a Redis lock. */
  private async recompute<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl: CacheTtl<T>,
    options: GetOrSetOptions
  ): Promise<Recomputed<T>> {
    // Try to acquire lock to prevent cache stampede
    const lockKey = `lock:${key}`;
    const redis = redisService.getClient();
    const acquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');

    if (acquired) {
      try {
        // Double-check cache (another request may have populated it)
        const freshCache = await redisService.get(key);
        if (freshCache) {
          return { data: JSON.parse(freshCache), serialized: freshCache };
        }

        const data = await this.fetchOrMarkFailed(key, fetchFn, ttl);
        const serialized = JSON.stringify(data);
        await this.store(key, data, serialized, ttl, options);
        return { data, serialized };
      } finally {
        await redisService.delete(lockKey);
      }
    }

    // Lock not acquired — wait for the lock holder (another instance) to
    // populate the cache for as long as it holds the lock (up to 15s). Giving
    // up after 600ms let a burst on one slow key run the same heavy query once
    // per request.
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const retryCache = await redisService.get(key);
      if (retryCache) {
        return { data: JSON.parse(retryCache), serialized: retryCache };
      }
      if (!(await redis.exists(lockKey))) break; // holder failed or finished without caching
    }

    // Lock holder failed (or is still running after 15s): fetch directly
    const data = await this.fetchOrMarkFailed(key, fetchFn, ttl);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(data);
    } catch {
      serialized = undefined;
    }
    return { data, serialized };
  }

  /** The value under its TTL, and its last copy (see lastCopyKeepS). */
  private async store<T>(
    key: string,
    data: T,
    serialized: string,
    ttl: CacheTtl<T>,
    options: GetOrSetOptions
  ): Promise<void> {
    const seconds = resolveTtl(ttl, data);
    const writes = [redisService.set(key, serialized, seconds)];
    const live = seconds <= LIVE_TTL_MAX_S || options.refreshInBackground === true;
    const optedIn = options.lastCopyKeepS !== undefined;
    const keepCopy =
      options.lastCopy !== false &&
      serialized !== undefined &&
      (live || optedIn || serialized.length <= LAST_COPY_MAX_CHARS);
    if (keepCopy) {
      // Built by hand: the value is already serialized, don't do it twice.
      const copy = `{"at":${Date.now()},"ttl":${seconds},"v":${serialized}}`;
      writes.push(redisService.set(lastCopyKey(key), copy, lastCopyKeepS(seconds, live, options.lastCopyKeepS)));
    } else if (options.lastCopy !== false) {
      // Too big to copy: a copy written while the value was smaller must not
      // be served later as the last value.
      writes.push(redisService.delete(lastCopyKey(key)));
    }
    await Promise.all(writes);
  }

  private async readLastCopy<T>(key: string): Promise<LastCopy<T> | null> {
    const raw = await redisService.get(lastCopyKey(key));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { at?: unknown; ttl?: unknown; v?: T };
      if (typeof parsed.at !== 'number' || typeof parsed.ttl !== 'number' || !('v' in parsed)) return null;
      return { at: parsed.at, ttl: parsed.ttl, value: parsed.v as T };
    } catch {
      return null;
    }
  }
  
  /**
   * Stale-while-revalidate read for slow, recomputable aggregates. The last
   * value is served at once; once it is older than `freshS`, one caller (Redis
   * lock) recomputes it in the background while everyone keeps the old value.
   * Only a cold key (never computed, or idle past `keepS`) waits for `fetchFn`.
   * A caller over its budget of billed upstream calls (see getOrSetWithMeta)
   * never starts the refresh or the cold compute: it gets the old value, else
   * its refusal.
   */
  async getOrRefresh<T>(key: string, fetchFn: () => Promise<T>, freshS: number, keepS: number): Promise<T> {
    if (!redisService.isHealthy()) {
      const refusal = upstreamRefusal();
      if (refusal) throw refusal;
      return fetchFn();
    }
    const swrKey = `${key}:swr`;
    const store = async (value: T): Promise<void> => {
      await redisService.set(swrKey, JSON.stringify({ at: Date.now(), value }), keepS);
    };
    try {
      const raw = await redisService.get(swrKey);
      if (raw) {
        const entry = JSON.parse(raw) as { at: number; value: T };
        if (Date.now() - entry.at > freshS * 1000 && !upstreamRefusal()) {
          const lockKey = `lock:${swrKey}`;
          const acquired = await redisService.getClient().set(lockKey, '1', 'EX', 120, 'NX');
          if (acquired) {
            void fetchFn()
              .then(store)
              .catch((error) => {
                logDeduplicator.warn('Background cache refresh failed', {
                  key,
                  errorType: error instanceof Error ? error.name : typeof error,
                });
              })
              .finally(() => void redisService.delete(lockKey));
          }
        }
        return entry.value;
      }
      // Cold key: compute once behind the regular stampede lock, then keep it
      // warm. The `:swr` entry already is the long-lived copy.
      return await this.getOrSet(`${key}:cold`, async () => {
        const value = await fetchFn();
        await store(value);
        return value;
      }, freshS, { lastCopy: false });
    } catch (error) {
      // The caller's own refusal (cold key): not a cache error, nothing to compute instead.
      if (isCallerRefusal(error)) throw error;
      logDeduplicator.warn('Cache error, falling back to direct fetch', {
        key,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
      const refusal = upstreamRefusal();
      if (refusal) throw refusal;
      return fetchFn();
    }
  }

  /**
   * Invalide une clé de cache (et sa dernière copie, qui sinon resservirait
   * l'ancienne valeur)
   * @param key Clé de cache à invalider
   */
  async invalidate(key: string): Promise<void> {
    try {
      await Promise.all([redisService.delete(key), redisService.delete(lastCopyKey(key))]);
      logDeduplicator.info('Cache invalidated', { key });
    } catch (error) {
      logDeduplicator.error('Error invalidating cache:', { 
        error, 
        key,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
  
  /**
   * Invalide toutes les clés de cache correspondant à un pattern (et leurs
   * dernières copies)
   * @param pattern Pattern des clés à invalider
   */
  async invalidateByPattern(pattern: string): Promise<void> {
    try {
      const [keys, copies] = await Promise.all([
        redisService.scan(pattern),
        redisService.scan(lastCopyKey(pattern)),
      ]);
      const all = [...new Set([...(keys ?? []), ...(copies ?? [])])];
      if (all.length > 0) {
        await Promise.all(all.map(key => redisService.delete(key)));
        logDeduplicator.info('Cache invalidated by pattern', { 
          pattern, 
          count: all.length 
        });
      }
    } catch (error) {
      logDeduplicator.error('Error invalidating cache by pattern:', { 
        error, 
        pattern,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

function swrWindowMs(ttlS: number): number {
  return Math.max(SWR_MIN_S, ttlS * SWR_TTL_MULTIPLE) * 1000;
}

/** A copy older than its TTL (plus STALE_MARGIN_MS): flagged stale when served. */
function isOldCopy<T>(copy: LastCopy<T>): boolean {
  return Date.now() - copy.at > copy.ttl * 1000 + STALE_MARGIN_MS;
}

/** What a follower of a recomputation gets: a copy of what was stored, never the leader's object. */
function copyOf<T>({ data, serialized }: Recomputed<T>): T {
  return serialized !== undefined ? JSON.parse(serialized) : data;
}

/** The promise's value if it resolves within `ms`, else undefined (a rejection too). */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}

// Instance singleton du service de cache
export const cacheService = new CacheService();
