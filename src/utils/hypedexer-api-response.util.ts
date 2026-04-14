/**
 * HypeDexer REST uses OpenAPI `APIResponse`: { success, message?, data, total_count?, ... }.
 * Indexer routes forward that object as LiquidTerminal's `data`, which double-wraps the real payload.
 * This peels nested APIResponse envelopes so clients receive the leaf business payload in `data`.
 */
const HYPE_DEXER_ENVELOPE_KEYS = new Set([
  'success',
  'message',
  'data',
  'total_count',
  'execution_time_ms',
  'next_cursor',
  'has_more',
]);

function isHypeDexerApiEnvelope(o: Record<string, unknown>): boolean {
  if (!('data' in o)) return false;
  const keys = Object.keys(o);
  return keys.length > 0 && keys.every((k) => HYPE_DEXER_ENVELOPE_KEYS.has(k));
}

/**
 * @throws Error when a nested envelope reports `success: false`
 */
export function unwrapHypeDexerApiPayload(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) return body;
  if (typeof body !== 'object') return body;

  const o = body as Record<string, unknown>;

  if (o.success === false) {
    const msg =
      typeof o.message === 'string'
        ? o.message
        : typeof o.error === 'string'
          ? o.error
          : 'HypeDexer request failed';
    throw new Error(msg);
  }

  if (isHypeDexerApiEnvelope(o)) {
    return unwrapHypeDexerApiPayload(o.data);
  }

  return body;
}
