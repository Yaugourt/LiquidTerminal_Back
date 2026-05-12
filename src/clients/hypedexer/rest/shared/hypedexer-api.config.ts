/**
 * Shared base URL and headers for HypeDexer REST (HL Indexer).
 * Reuses HL_INDEXER_* env vars for all HypeDexer REST clients (pass-through and polling).
 */
import pkg from '../../../../../package.json';

function normalizeHypedexerBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.replace(/\/+$/, '');
}

function resolveHypedexerApiKey(): string {
  const raw = (process.env.HL_INDEXER_API_KEY || '').trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'test') {
      // Tests run without a real key; return a deterministic placeholder so
      // the rest of the boot path stays exercised without leaking config.
      return 'test-key';
    }
    throw new Error(
      '[hypedexer] HL_INDEXER_API_KEY is required but missing or empty. ' +
        'Set it in your environment before starting the server.'
    );
  }
  return raw;
}

export const HYPEDEXER_API_URL = normalizeHypedexerBaseUrl(
  process.env.HL_INDEXER_API_URL || 'https://api.hypedexer.com'
);
export const HYPEDEXER_API_KEY = resolveHypedexerApiKey();

const HYPEDEXER_USER_AGENT = `liquidterminal-back/${pkg.version || '0.0.0'}`;

export const hypedexerJsonHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate',
  'User-Agent': HYPEDEXER_USER_AGENT,
  'X-API-Key': HYPEDEXER_API_KEY,
};
