/**
 * Redis cache keys and TTLs for the DefiLlama proxy.
 * DefiLlama's TVL/volume/fees refresh roughly daily, so minutes-long caches are
 * safe and shield the free upstream from per-page-view traffic. Prices move
 * faster and use a short TTL.
 */
export const DEFILLAMA_CACHE_PREFIX = 'defillama' as const;

export const DEFILLAMA_CACHE_KEYS = {
  protocols: `${DEFILLAMA_CACHE_PREFIX}:protocols`,
  chains: `${DEFILLAMA_CACHE_PREFIX}:chains`,
  protocol: (slug: string) => `${DEFILLAMA_CACHE_PREFIX}:protocol:${slug}`,
  tvl: (slug: string) => `${DEFILLAMA_CACHE_PREFIX}:tvl:${slug}`,
  dexs: (slug: string) => `${DEFILLAMA_CACHE_PREFIX}:dexs:${slug}`,
  fees: (slug: string, dataType: string) => `${DEFILLAMA_CACHE_PREFIX}:fees:${slug}:${dataType}`,
  prices: (coins: string) => `${DEFILLAMA_CACHE_PREFIX}:prices:${coins}`,
  overview: (slug: string) => `${DEFILLAMA_CACHE_PREFIX}:overview:${slug}`,
} as const;

/** TTLs in seconds. */
export const DEFILLAMA_TTL = {
  protocols: 600, // 10 min — large list, changes slowly
  chains: 600,
  protocol: 300, // 5 min
  tvl: 300,
  dexs: 300,
  fees: 300,
  prices: 60, // 1 min — prices move
  overview: 300,
} as const;
