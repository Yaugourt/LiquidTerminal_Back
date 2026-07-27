import { createHash, timingSafeEqual } from 'crypto';

/**
 * SHA-256 of a UTF-8 string, as a fixed 32-byte buffer.
 * Hashing before comparison normalises length, so `timingSafeEqual` (which
 * throws on a length mismatch) can be used without the length itself leaking.
 */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time membership test of a provided secret against a small set of
 * valid keys.
 *
 * `Array.includes` / `===` short-circuit on the first differing byte, leaking a
 * timing signal an attacker can use to recover a key byte-by-byte. This always
 * compares against every candidate over equal-length (hashed) buffers and never
 * early-returns, so wall-clock time is independent of how close a guess is.
 */
export function matchesAnyKey(provided: string, validKeys: readonly string[]): boolean {
  if (!provided || validKeys.length === 0) return false;
  const providedHash = sha256(provided);
  let matched = false;
  for (const key of validKeys) {
    if (timingSafeEqual(providedHash, sha256(key))) {
      matched = true;
    }
  }
  return matched;
}
