/**
 * URL masking helpers for log redaction.
 * Masks sensitive query parameter values (wallet addresses) before logging.
 */

const SENSITIVE_QUERY_PARAMS = ['user', 'address'];

/**
 * Replace values of sensitive query parameters in a URL with a masked placeholder.
 * Handles both full URLs and URL fragments (path?query).
 * If the URL cannot be parsed, falls back to a regex-based replacement.
 */
export function maskSensitiveUrl(url: string): string {
  if (!url) return url;

  // Regex fallback applied first — works on relative URLs / endpoints too.
  let masked = url;
  for (const param of SENSITIVE_QUERY_PARAMS) {
    const re = new RegExp(`([?&]${param}=)([^&#\\s]+)`, 'gi');
    masked = masked.replace(re, `$1***masked***`);
  }
  return masked;
}
