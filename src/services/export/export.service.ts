import {
  ExportPassthroughClient,
  type ExportPage,
} from '../../clients/hypedexer/rest/export/export-passthrough.client';
import {
  EXPORT_MAX_PAGES,
  EXPORT_PAGE_SIZE,
  EXPORT_PREVIEW_ROWS,
} from '../../constants/export.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';
import type { ExportDataset } from './export.manifest';
import { getLocalSource, type LocalSourcePage } from './export.local-sources';

export type ExportQueryParams = Record<string, string>;

export interface ExportPreview {
  rows: Record<string, unknown>[];
  /** Column keys discovered from the rows, in first-seen order. */
  columns: string[];
  /** Upstream row count when it reports one; null when it does not. */
  totalCount: number | null;
}

/**
 * Reads datasets from HypeDexer and turns them into CSV.
 *
 * Columns are discovered rather than declared: the manifest names the endpoint,
 * the response names the fields. That keeps forty datasets from needing forty
 * hand-maintained column lists that would drift the first time upstream adds a
 * field.
 */
export class ExportService {
  private static instance: ExportService;
  private readonly client = ExportPassthroughClient.getInstance();

  public static getInstance(): ExportService {
    if (!ExportService.instance) {
      ExportService.instance = new ExportService();
    }
    return ExportService.instance;
  }

  /**
   * Fetches one page from whichever source the dataset declares, so the paging
   * loop and the CSV writer stay source-agnostic.
   *
   * `page` is 1-based because every local service paginates that way; the
   * provider's endpoints are told where the page starts (`from`).
   */
  private async fetchPage(
    dataset: ExportDataset,
    params: ExportQueryParams,
    limit: number,
    page: number,
    /** Where the page starts: the rows read so far, or `next_cursor` of the page before. */
    from: { offset: number; cursor: string | null } = { offset: 0, cursor: null }
  ): Promise<ExportPage> {
    if (dataset.source === 'local') {
      const resolver = getLocalSource(dataset.id);
      if (!resolver) {
        throw new Error(`No local resolver registered for dataset "${dataset.id}"`);
      }
      const local: LocalSourcePage = await resolver({ params, limit, page });
      return {
        rows: local.rows,
        nextCursor: null,
        // A source that cannot page has, by definition, nothing after page 1.
        hasMore: local.pageable ? null : false,
        totalCount: local.totalCount,
      };
    }

    const pageParams: Record<string, string | number> = { ...sourceParams(dataset, params), limit };
    if (dataset.pagination === 'cursor') {
      if (from.cursor !== null) pageParams[dataset.cursorParam ?? 'cursor'] = from.cursor;
    } else if (from.offset > 0) {
      pageParams.offset = from.offset;
    }
    return this.client.fetchPage(dataset.upstreamPath, pageParams);
  }

  /** First rows and their columns. Free: never spends the caller's quota. */
  public async preview(
    dataset: ExportDataset,
    params: ExportQueryParams
  ): Promise<ExportPreview> {
    const page = await this.fetchPage(dataset, params, EXPORT_PREVIEW_ROWS, 1);
    // Sliced rather than trusted: /builders/list ignores `limit` and answered
    // 1100 rows to a request for 5, which would make a "preview" download the
    // whole dataset.
    const rows = page.rows.slice(0, EXPORT_PREVIEW_ROWS).map((r) => redactRow(flattenRow(r)));
    return {
      rows,
      columns: collectColumns(rows),
      totalCount: page.totalCount,
    };
  }

  /**
   * Walks every page and yields CSV chunks as they are built, so a large export
   * is streamed to the client instead of assembled in memory.
   *
   * Yields nothing at all when the dataset is empty — the caller decides whether
   * that is a 404 or a header-only file.
   */
  public async *streamCsv(
    dataset: ExportDataset,
    params: ExportQueryParams,
    requestedColumns?: string[],
    /** Called after each page fetched from a paid upstream (not local sources). */
    onUpstreamPage?: () => void,
    /**
     * Called once, with the source's own row count, after the first page is read
     * and before the first chunk is yielded — the last moment the route can still
     * put a header on the response.
     */
    onFirstPage?: (info: { totalCount: number | null }) => void
  ): AsyncGenerator<string, { rowCount: number; truncated: boolean }, void> {
    const frozenParams = freezeWindow(dataset, params);

    // Deduplicated and filtered: a repeated column multiplies egress for the
    // same upstream cost, and a denied one must not come back through the query.
    const cleanRequested = requestedColumns?.length
      ? [...new Set(requestedColumns)].filter((c) => !isDeniedColumn(c))
      : undefined;
    let columns: string[] | null = cleanRequested?.length ? cleanRequested : null;
    let pageNumber = 1;
    // Tracked separately from `columns`: when the caller supplies its own list,
    // `columns` is already set on entry, so keying the header off it emitted a
    // headerless CSV on exactly the path the column picker uses.
    let headerWritten = false;
    let rowCount = 0;
    let pages = 0;
    let lastPage: ExportPage | null = null;
    let lastPageLimit = 0;
    let drained = false;
    let cursor: string | null = null;
    let offset = 0;
    let lastRows = '';
    let repeated = false;
    const seen = new Set<string>();

    while (pages < EXPORT_MAX_PAGES && rowCount < dataset.maxRows) {
      const remaining = dataset.maxRows - rowCount;
      const pageSize = dataset.pageSize ?? EXPORT_PAGE_SIZE;
      // One size for every page of a walk by cursor: the source may number pages of that size.
      const pageLimit = dataset.pagination === 'cursor' ? pageSize : Math.min(pageSize, remaining);

      let page: ExportPage;
      try {
        page = await this.fetchPage(dataset, frozenParams, pageLimit, pageNumber, { offset, cursor });
      } catch (error) {
        logDeduplicator.error('Export page fetch failed', {
          dataset: dataset.id,
          page: pages,
          rowsSoFar: rowCount,
          error: error instanceof Error ? error.message : String(error),
        });
        // Rethrow: a partial CSV that looks complete is worse than a failure,
        // and the quota is only recorded once the stream finishes cleanly.
        throw error;
      }

      pages += 1;
      if (dataset.source !== 'local') onUpstreamPage?.();
      if (pages === 1) onFirstPage?.({ totalCount: page.totalCount });
      lastPage = page;
      lastPageLimit = pageLimit;
      if (page.rows.length === 0) {
        drained = true;
        break;
      }

      // A source that does not know how it is asked for its next rows answers the same page again:
      // the file would hold it a hundred times, each one paid for.
      const rowsAsText = JSON.stringify(page.rows);
      if (pages > 1 && rowsAsText === lastRows) {
        repeated = true;
        break;
      }
      lastRows = rowsAsText;

      const flattened = page.rows.map((r) => redactRow(flattenRow(r)));

      if (!columns) {
        columns = collectColumns(flattened);
        if (columns.length === 0) {
          drained = true;
          break;
        }
      }
      if (!headerWritten) {
        headerWritten = true;
        yield `${columns.map(csvCell).join(',')}\n`;
      }

      for (const row of flattened) {
        if (rowCount >= dataset.maxRows) break;
        if (dataset.uniqueBy) {
          const id = JSON.stringify(dataset.uniqueBy.map((column) => row[column]));
          if (seen.has(id)) continue;
          seen.add(id);
        }
        yield `${columns.map((key) => csvCell(row[key])).join(',')}\n`;
        rowCount += 1;
      }

      // Stop conditions, in the order the source makes them knowable.
      if (
        dataset.pagination === 'none' ||
        page.hasMore === false ||
        page.rows.length < pageLimit ||
        (dataset.pagination === 'cursor' && page.nextCursor === null)
      ) {
        drained = true;
        break;
      }
      pageNumber += 1;
      cursor = page.nextCursor;
      offset += page.rows.length;
    }

    if (repeated) {
      logDeduplicator.warn('Export stopped: its source answered the same page twice', {
        dataset: dataset.id,
        rows: rowCount,
        pages,
      });
      return { rowCount, truncated: true };
    }

    // Left through the row or page ceiling rather than the end of the data.
    // The source's own count settles it when it gives one; otherwise a full
    // last page that did not say it was the last is taken as "there is more".
    const truncated =
      !drained &&
      lastPage !== null &&
      (lastPage.totalCount !== null
        ? lastPage.totalCount > rowCount
        : lastPage.hasMore !== false && lastPage.rows.length >= lastPageLimit);
    if (truncated) {
      logDeduplicator.warn('Export stopped at its ceiling with rows left', {
        dataset: dataset.id,
        rows: rowCount,
        pages,
        totalCount: lastPage?.totalCount ?? null,
      });
    }

    return { rowCount, truncated };
  }
}

/**
 * Pins the end of the window to the moment the export started, but only when
 * the caller already bounded the start.
 *
 * Offset pagination over a live feed only stays coherent while the underlying
 * set stops growing, so freezing the end is the right instinct. It is also a
 * trap: measured on /fills 2026-07-26, an `end_time` with no `start_time` takes
 * ~47s per page (upstream scans the whole history), where the same call with
 * both bounds takes ~2.2s and with neither takes ~2.0s.
 *
 * So: bounded start → pin the end (fast and stable). Unbounded start → leave it
 * alone and accept that a busy feed may shift rows between pages, which beats
 * a request that times out.
 */
export function freezeWindow(
  dataset: ExportDataset,
  params: ExportQueryParams
): ExportQueryParams {
  const acceptsEnd = dataset.params.some((p) => p.key === 'end_time');
  if (!acceptsEnd || params.end_time || !params.start_time) return params;
  return { ...params, end_time: new Date().toISOString() };
}

/** The caller's params as the dataset's source names and writes them. */
export function sourceParams(dataset: ExportDataset, params: ExportQueryParams): ExportQueryParams {
  const out: ExportQueryParams = {};
  for (const [key, value] of Object.entries({ ...dataset.defaults, ...params })) {
    out[dataset.sourceNames?.[key] ?? key] = dataset.sourceEpochMs?.includes(key) ? toEpochMs(value) : value;
  }
  return out;
}

/** A date the export accepts (ISO, UTC when it names no zone, or epoch seconds / ms) as epoch ms. */
function toEpochMs(value: string): string {
  if (/^\d+$/.test(value)) return value.length <= 10 ? `${value}000` : value;
  const zoned = /T.*(Z|[+-]\d{2}:?\d{2})$/i.test(value) || !/T/i.test(value);
  const ms = Date.parse(zoned ? value : `${value}Z`);
  return Number.isNaN(ms) ? value : String(ms);
}

/**
 * Flattens one level of nesting so a CSV cell never holds a raw object.
 * Deeper structures and arrays are JSON-encoded: lossless, and still readable
 * in a spreadsheet.
 */
export function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        out[`${key}.${childKey}`] = isScalar(childValue) ? childValue : JSON.stringify(childValue);
      }
      continue;
    }
    out[key] = isScalar(value) ? value : JSON.stringify(value);
  }
  return out;
}

/**
 * Columns never written to a CSV, whatever the source returns.
 *
 * The catalog discovers columns instead of declaring them, which is what keeps
 * 34 datasets maintainable — but it also means any field a service adds is
 * exported by default. The backend's own sources carry personal and internal
 * data on their rows: `/readlists/public` and `/educational/resources` both
 * embed `creator: {id, name, email}`, and wiki rows carry the moderator's id
 * and their review notes.
 *
 * Matched on the flattened key, so `creator.email` is caught as well as `email`.
 */
const DENIED_COLUMNS = new Set([
  'email',
  'privyuserid',
  'reviewnotes',
  'reviewedby',
]);

/**
 * Denied if ANY dot-segment of the flattened key matches — not just the leaf.
 * The old leaf-only check let a sensitive field slip through once its parent
 * object was renamed (e.g. `reviewer.email`, `submitter.reviewNotes`) or nested
 * a level deeper. Matching every segment closes that class of gap. It only ever
 * removes columns whose path contains a denied name, so legitimate data is
 * never dropped.
 */
function isDeniedColumn(key: string): boolean {
  return key
    .toLowerCase()
    .split('.')
    .some((segment) => DENIED_COLUMNS.has(segment));
}

/** Strips denied keys from a flattened row. */
export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isDeniedColumn(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Union of keys across rows, in first-seen order — rows may omit optional fields. */
export function collectColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

/**
 * Leading characters a spreadsheet treats as the start of a formula. A cell
 * beginning with one of them is executed by Excel, LibreOffice and Sheets on
 * open, which turns any upstream string into code running on the downloader's
 * machine (CSV injection, CWE-1236).
 *
 * This is not hypothetical here: user-chosen vault names already include
 * `=1M=`, `+convexity`, `-VectorZero-` and `@Alwaleed_Talal` today.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * RFC 4180 cell, with formula injection neutralised.
 *
 * A dangerous cell is prefixed with a single quote and force-quoted: the value
 * still reads correctly in a spreadsheet, but it is inert. Numbers are exempt —
 * they cannot carry a payload, and prefixing them would break every numeric
 * column (a negative number legitimately starts with `-`).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);

  const text = String(value);
  const dangerous = text.length > 0 && FORMULA_TRIGGERS.includes(text[0]);
  const escaped = text.replace(/"/g, '""');

  if (dangerous) return `"'${escaped}"`;
  if (!/[",\r\n]/.test(text)) return text;
  return `"${escaped}"`;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}
