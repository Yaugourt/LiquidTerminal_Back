import { HyperfolioYieldResponse } from '../types/hyperfolio.types';

/**
 * Hyperfolio prices some spam pools with fake token prices: rows with tens of
 * trillions of TVL, and a `total_value_usd` that adds them up. No real pool on
 * Hyperliquid comes near these bounds (the largest held ~$2B in 2026-10).
 */
export const MAX_TRUSTED_POOL_TVL_USD = 20_000_000_000;
export const MAX_TRUSTED_TOTAL_TVL_USD = 50_000_000_000;

/**
 * Drops the rows whose `pool.tvlUsd` is past MAX_TRUSTED_POOL_TVL_USD, and
 * flags `metadata.totals_untrusted` when `total_value_usd` is past
 * MAX_TRUSTED_TOTAL_TVL_USD (the totals are kept as received; the front shows
 * "—" for them). Pagination is left as Hyperfolio sent it: a page may hold a
 * few rows less than `page_size`.
 */
export function sanitizeYieldResponse(response: HyperfolioYieldResponse): HyperfolioYieldResponse {
  const data = Array.isArray(response.data)
    ? response.data.filter((row) => !((row.pool?.tvlUsd ?? 0) > MAX_TRUSTED_POOL_TVL_USD))
    : response.data;
  const total = response.metadata?.totals?.total_value_usd;
  const untrusted = typeof total === 'number' && total > MAX_TRUSTED_TOTAL_TVL_USD;
  return {
    ...response,
    data,
    metadata: untrusted ? { ...response.metadata, totals_untrusted: true } : response.metadata,
  };
}
