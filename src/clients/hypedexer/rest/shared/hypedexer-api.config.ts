/**
 * Shared base URL and headers for HypeDexer REST (HL Indexer).
 * Reuses HL_INDEXER_* env vars for all HypeDexer REST clients (pass-through and polling).
 */
function normalizeHypedexerBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.replace(/\/+$/, '');
}

export const HYPEDEXER_API_URL = normalizeHypedexerBaseUrl(
  process.env.HL_INDEXER_API_URL || 'https://api.hypedexer.com'
);
export const HYPEDEXER_API_KEY = process.env.HL_INDEXER_API_KEY || '';

export const hypedexerJsonHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-API-Key': HYPEDEXER_API_KEY,
};
