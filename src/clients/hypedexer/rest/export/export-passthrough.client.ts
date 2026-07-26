import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { maskSensitiveUrl } from '../../../../utils/url-masking';

/** One page of rows plus whatever the upstream told us about the next one. */
export interface ExportPage {
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  hasMore: boolean | null;
  totalCount: number | null;
}

/**
 * Generic read-only passthrough to HypeDexer, used only by the CSV export.
 *
 * The other clients call `getUnwrapped`, which peels the APIResponse envelope
 * and therefore throws away `next_cursor` / `has_more`. An export has to walk
 * every page, so it reads the raw body and unwraps it itself, keeping the
 * pagination handles.
 *
 * It takes an upstream path rather than a typed method per endpoint: the
 * manifest already names the path, and a typed method per dataset would mean
 * forty near-identical wrappers.
 */
export class ExportPassthroughClient extends HypeDexerBaseClient {
  private static instance: ExportPassthroughClient;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
  }

  public static getInstance(): ExportPassthroughClient {
    if (!ExportPassthroughClient.instance) {
      ExportPassthroughClient.instance = new ExportPassthroughClient();
    }
    return ExportPassthroughClient.instance;
  }

  public async fetchPage(
    path: string,
    params: Record<string, string | number | boolean | undefined>
  ): Promise<ExportPage> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue;
      search.append(key, String(value));
    }
    const query = search.toString();
    const endpoint = query ? `${path}?${query}` : path;

    // Masked: the query string carries `user=0x…` on several datasets, and
    // every other outbound log in the codebase goes through this helper. This
    // line fires up to 100 times per export.
    logDeduplicator.info('ExportPassthroughClient.fetchPage', {
      endpoint: maskSensitiveUrl(endpoint),
    });

    const body = await this.get<unknown>(endpoint);
    return normalizeExportPage(body);
  }
}

/**
 * Pulls rows and pagination handles out of whatever shape the upstream used.
 *
 * HypeDexer answers either a bare array, an APIResponse envelope, or an
 * envelope whose `data` is itself an envelope. Anything that is not a list of
 * objects (a stats blob, a scalar) is reported as zero rows rather than
 * coerced, so a mis-registered dataset fails loudly instead of exporting junk.
 */
export function normalizeExportPage(body: unknown): ExportPage {
  const empty: ExportPage = { rows: [], nextCursor: null, hasMore: null, totalCount: null };
  if (body === null || body === undefined) return empty;

  if (Array.isArray(body)) {
    return { ...empty, rows: body.filter(isPlainRow), totalCount: body.length };
  }

  if (typeof body !== 'object') return empty;
  const envelope = body as Record<string, unknown>;

  if (envelope.success === false) {
    const message =
      typeof envelope.message === 'string' ? envelope.message : 'HypeDexer request failed';
    throw new Error(message);
  }

  const nextCursor = typeof envelope.next_cursor === 'string' ? envelope.next_cursor : null;
  const hasMore = typeof envelope.has_more === 'boolean' ? envelope.has_more : null;
  const totalCount =
    typeof envelope.total_count === 'number'
      ? envelope.total_count
      : typeof envelope.total === 'number'
        ? envelope.total
        : null;

  const inner = envelope.data;

  if (Array.isArray(inner)) {
    return { rows: inner.filter(isPlainRow), nextCursor, hasMore, totalCount };
  }

  // Nested envelope: recurse, but keep the outer pagination handles when the
  // inner level did not carry its own.
  if (inner !== null && typeof inner === 'object') {
    const nested = normalizeExportPage(inner);
    return {
      rows: nested.rows,
      nextCursor: nested.nextCursor ?? nextCursor,
      hasMore: nested.hasMore ?? hasMore,
      totalCount: nested.totalCount ?? totalCount,
    };
  }

  return { ...empty, nextCursor, hasMore, totalCount };
}

function isPlainRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
