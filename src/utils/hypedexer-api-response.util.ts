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
  'status',
  'count',
  // Pagination keys HypeDexer added to /hip4/markets (July 2026); without
  // them the every() check rejects the envelope and lists collapse to [].
  'limit',
  'offset',
  'next_offset',
  'total',
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

/**
 * After {@link unwrapHypeDexerApiPayload}, list endpoints often resolve to a bare `T[]`.
 * Services expect the OpenAPI `APIResponse` shape with a `data` array. Re-wrap arrays only.
 */
export function coerceHypedexerListApiResponse<T>(raw: unknown): {
  success: boolean;
  message: string;
  data: T[];
  total_count: number | null;
  execution_time_ms: number;
  next_cursor: string | null;
  has_more: boolean | null;
} {
  if (Array.isArray(raw)) {
    return {
      success: true,
      message: '',
      data: raw,
      total_count: raw.length,
      execution_time_ms: 0,
      next_cursor: null,
      has_more: null,
    };
  }
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'data' in raw &&
    Array.isArray((raw as { data: unknown }).data)
  ) {
    return raw as {
      success: boolean;
      message: string;
      data: T[];
      total_count: number | null;
      execution_time_ms: number;
      next_cursor: string | null;
      has_more: boolean | null;
    };
  }
  throw new Error('Invalid HypeDexer list response: expected array or envelope with data[]');
}
