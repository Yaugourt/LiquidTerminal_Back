/**
 * Redis keys, pub/sub channels, and distributed lock names for HypeDexer (HL Indexer) REST integrations.
 * Prefer one channel per **domain** refresh (batch publish after multi-key SET), not per endpoint.
 *
 * Polling clients under `hypedexer/rest/` may use legacy Redis keys (e.g. `builders:all`); optional migration under `hypedexer:` prefix is separate.
 */

/** Prefix for new indexer-backed cache keys (optional migration from legacy keys). */
export const HYPEDEXER_CACHE_PREFIX = 'hypedexer' as const;

/** Pub/sub: one channel per domain when background polling refreshes multiple keys. */
export const HYPEDEXER_CHANNELS = {
  fills: `${HYPEDEXER_CACHE_PREFIX}:fills:updated`,
  users: `${HYPEDEXER_CACHE_PREFIX}:users:updated`,
  overview: `${HYPEDEXER_CACHE_PREFIX}:overview:updated`,
  hip3: `${HYPEDEXER_CACHE_PREFIX}:hip3:updated`,
  analytics: `${HYPEDEXER_CACHE_PREFIX}:analytics:updated`,
  builders: `${HYPEDEXER_CACHE_PREFIX}:builders:updated`,
} as const;

/** Distributed locks for pollers (seconds TTL typical: 90). */
export const HYPEDEXER_LOCKS = {
  pollFills: 'poll:hypedexer:fills',
  pollOverview: 'poll:hypedexer:overview',
  pollHip3: 'poll:hypedexer:hip3',
} as const;

/** Example TTLs (seconds). Heavy /fills/* = on-demand by default; use short TTL only for hot keys. */
export const HYPEDEXER_TTL = {
  fillsCount: 30,
  overviewSlice: 55,
} as const;
