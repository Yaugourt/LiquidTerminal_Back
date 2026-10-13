/**
 * Redis cache keys and TTLs for the Hypurrscan feeds served to the browser
 * (`/market/auction/perp`, `/explorer/deploys`, `/explorer/aliases`). Hypurrscan
 * sends them uncompressed and the browsers used to poll it directly; one shared
 * copy per feed keeps the upstream cost flat in visitors.
 */
export const HYPURRSCAN_CACHE_PREFIX = 'hypurrscan:feed' as const;

export const HYPURRSCAN_CACHE_KEYS = {
  pastAuctionsPerp: `${HYPURRSCAN_CACHE_PREFIX}:pastAuctionsPerp`,
  deploys: `${HYPURRSCAN_CACHE_PREFIX}:deploys`,
  globalAliases: `${HYPURRSCAN_CACHE_PREFIX}:globalAliases`,
} as const;

/** TTLs in seconds: each matches the front's poll for that feed. */
export const HYPURRSCAN_TTL = {
  pastAuctionsPerp: 60, // a perp deploy auction every few days
  deploys: 15, // the explorer's live deploys list
  globalAliases: 300, // labels change rarely
} as const;

/**
 * How long the last copy of a feed outlives its key: the data is slow-moving,
 * so a day-old copy still beats an error during a Hypurrscan outage.
 */
export const HYPURRSCAN_LAST_COPY_KEEP_S = 86_400;
