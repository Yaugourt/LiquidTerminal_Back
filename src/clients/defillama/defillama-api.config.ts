/**
 * Shared base hosts and headers for DefiLlama's free (keyless) API.
 *
 * DefiLlama splits its free API across two hosts:
 *  - `https://api.llama.fi`    → protocols, TVL, chains, DEX volume, fees/revenue
 *  - `https://coins.llama.fi`  → token prices (current/historical)
 *
 * Both are public and require no API key. Paid endpoints (derivatives/perps,
 * some overviews) answer `402 Payment Required` and are intentionally not wired.
 */

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export const DEFILLAMA_API_URL = normalizeBaseUrl(
  process.env.DEFILLAMA_API_URL || 'https://api.llama.fi'
);

export const DEFILLAMA_COINS_API_URL = normalizeBaseUrl(
  process.env.DEFILLAMA_COINS_API_URL || 'https://coins.llama.fi'
);

export const defillamaJsonHeaders: Record<string, string> = {
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate',
  'User-Agent': 'liquidterminal-back',
};
