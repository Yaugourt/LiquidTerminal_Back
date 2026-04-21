/**
 * Shared base URL and headers for HypeDexer REST (HL Indexer).
 * Reuses HL_INDEXER_* env vars for all HypeDexer REST clients (pass-through and polling).
 */
export const HYPEDEXER_API_URL = process.env.HL_INDEXER_API_URL || 'https://api.hypedexer.com';
/** HIP-4 is on testnet — separate base URL until mainnet launch. */
export const HYPEDEXER_TESTNET_API_URL = process.env.HL_INDEXER_TESTNET_API_URL || 'https://api.hypedexer.com/testnet';
export const HYPEDEXER_API_KEY = process.env.HL_INDEXER_API_KEY || '';

export const hypedexerJsonHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-API-Key': HYPEDEXER_API_KEY,
};
