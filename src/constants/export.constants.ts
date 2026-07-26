/**
 * CSV export limits.
 *
 * Exports are the only endpoint that can page an upstream provider dozens of
 * times for a single request, so they carry their own per-user quota on top of
 * the IP rate limiter. Same mechanism as CONTRIBUTION_LIMITS: a Redis sorted
 * set over a sliding window, not a calendar day, so "1 per day" cannot be
 * gamed by exporting twice around midnight.
 */
export const EXPORT_LIMITS = {
  /** Completed downloads allowed per user within WINDOW_MS. */
  MAX_EXPORTS_PER_DAY: 1,
  WINDOW_MS: 24 * 60 * 60 * 1000,
};

/**
 * Hard ceiling on rows in a single export, whatever the dataset asks for.
 * Above this the caller is told to narrow the window rather than served a
 * silently truncated file.
 */
export const EXPORT_MAX_ROWS = 50_000;

/**
 * Rows fetched per upstream page. Measured against /fills: 500 rows come back
 * in ~1.4s where 1000 took ~4.4s and occasionally hit the client timeout, so
 * the smaller page is both faster overall and far less likely to fail.
 */
export const EXPORT_PAGE_SIZE = 500;

/** Rows returned by the free preview call (never spends the quota). */
export const EXPORT_PREVIEW_ROWS = 5;

/**
 * Preview budget per user, per hour.
 *
 * The preview is free by design — nobody should burn their single daily export
 * on a typo — but free is not the same as unlimited: each call is one request
 * to a paid upstream provider, and the export quota does not cover it. Shaping
 * a query takes a handful of previews; a few dozen an hour is generous for a
 * human and closes the tap on a script.
 */
export const EXPORT_PREVIEW_LIMITS = {
  MAX_PREVIEWS_PER_WINDOW: 60,
  WINDOW_MS: 60 * 60 * 1000,
};

/**
 * Upstream pages a single export may walk. EXPORT_MAX_ROWS is the real limit;
 * this is the backstop for an upstream that keeps handing out cursors without
 * ever draining (HypeDexer has done it), so one request cannot loop forever.
 */
export const EXPORT_MAX_PAGES = Math.ceil(EXPORT_MAX_ROWS / EXPORT_PAGE_SIZE) + 5;
