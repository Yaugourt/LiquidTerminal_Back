/**
 * Redis cache keys and TTLs for the protocol-revenue endpoint.
 *
 * The raw Hypurrscan cumulative-fee history refreshes at most a few times an
 * hour upstream, so a 5 min cache shields it from per-page-view traffic. The
 * assembled per-window breakdown is cheap to rebuild but cached identically so
 * repeated dashboard polls round-trip the same payload.
 */
export const REVENUE_CACHE_PREFIX = 'revenue' as const;

export const REVENUE_CACHE_KEYS = {
  feesHistory: `${REVENUE_CACHE_PREFIX}:fees_history`,
  breakdown: (window: string) => `${REVENUE_CACHE_PREFIX}:breakdown:${window}`,
} as const;

/** TTLs in seconds. */
export const REVENUE_TTL = {
  feesHistory: 300, // 5 min
  breakdown: 300, // 5 min
} as const;
