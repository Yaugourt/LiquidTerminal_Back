import { WSLiquidationFilters } from '../types/websocket.types';

/**
 * Validation of the filters a client sends with a `liquidation` subscription.
 *
 * `liquidation` is the one subscription open to anonymous clients, and its
 * filters are evaluated inside the shared broadcast loop. Whatever a client
 * sends is therefore untrusted input that must be shaped like the matcher
 * expects (arrays of strings, a finite number) and bounded in size before it
 * is stored.
 */

/** Far above any real watchlist, far below anything that makes matching costly. */
export const MAX_FILTER_COINS = 50;
export const MAX_FILTER_WALLETS = 100;
/** Longest HIP-3 style coin symbol is well under this; an EVM address is 42. */
export const MAX_FILTER_COIN_LENGTH = 32;
export const MAX_FILTER_WALLET_LENGTH = 66;

export type LiquidationFiltersResult =
  | { ok: true; filters: WSLiquidationFilters }
  | { ok: false; error: string };

function normalizeStringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
  normalize: (s: string) => string
): { ok: true; list: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: `Invalid filters: ${field} must be an array of strings` };
  }
  if (value.length > maxItems) {
    return { ok: false, error: `Invalid filters: ${field} accepts at most ${maxItems} entries` };
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { ok: false, error: `Invalid filters: ${field} must be an array of strings` };
    }
    const trimmed = entry.trim();
    if (trimmed.length > maxLength) {
      return { ok: false, error: `Invalid filters: ${field} entries are limited to ${maxLength} characters` };
    }
    if (trimmed) seen.add(normalize(trimmed));
  }
  return { ok: true, list: [...seen] };
}

/**
 * Returns the normalized filters (unknown keys dropped, coins upper-cased,
 * wallets lower-cased, duplicates removed) or the reason they are refused.
 * Missing, null or empty filters are valid and mean "no filter". `null` or
 * `undefined` on an individual key also means "not set".
 */
export function normalizeLiquidationFilters(raw: unknown): LiquidationFiltersResult {
  if (raw === undefined || raw === null) return { ok: true, filters: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Invalid filters: expected an object' };
  }

  const input = raw as Record<string, unknown>;
  const filters: WSLiquidationFilters = {};

  if (input.coins !== undefined && input.coins !== null) {
    const r = normalizeStringList(input.coins, 'coins', MAX_FILTER_COINS, MAX_FILTER_COIN_LENGTH, (s) => s.toUpperCase());
    if (!r.ok) return r;
    filters.coins = r.list;
  }

  if (input.wallets !== undefined && input.wallets !== null) {
    const r = normalizeStringList(input.wallets, 'wallets', MAX_FILTER_WALLETS, MAX_FILTER_WALLET_LENGTH, (s) => s.toLowerCase());
    if (!r.ok) return r;
    filters.wallets = r.list;
  }

  if (input.minAmountUsd !== undefined && input.minAmountUsd !== null) {
    const v = input.minAmountUsd;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { ok: false, error: 'Invalid filters: minAmountUsd must be a finite number >= 0' };
    }
    filters.minAmountUsd = v;
  }

  return { ok: true, filters };
}
