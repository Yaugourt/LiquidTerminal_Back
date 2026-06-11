import { timingSafeEqual } from 'crypto';

/**
 * Returns the Telegram bot API keys configured via environment.
 * Both a primary and an optional secondary key are supported (rotation).
 */
export function getConfiguredBotApiKeys(): string[] {
  return [
    process.env.TELEGRAM_BOT_API_KEY,
    process.env.TELEGRAM_BOT_API_KEY_SECONDARY,
  ].filter(Boolean) as string[];
}

/**
 * Constant-time validation of a provided bot API key against the configured keys.
 * Returns false when no key is configured or the provided key is empty/invalid.
 *
 * Uses `timingSafeEqual` to avoid leaking key material through a timing side
 * channel; all candidate keys are compared (no early return) to keep timing uniform.
 */
export function isValidBotApiKey(provided: string | undefined | null): boolean {
  if (!provided) return false;

  const validKeys = getConfiguredBotApiKeys();
  if (validKeys.length === 0) return false;

  const providedBuf = Buffer.from(provided);
  let match = false;

  for (const key of validKeys) {
    const keyBuf = Buffer.from(key);
    if (keyBuf.length === providedBuf.length && timingSafeEqual(keyBuf, providedBuf)) {
      match = true;
    }
  }

  return match;
}
