import { Router, Request, Response, RequestHandler } from 'express';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireUser } from '../../middleware/roleMiddleware';
import {
  exportRateLimiter,
  exportPreviewRateLimiter,
  recordExport,
  releaseExport,
  getExportQuota,
} from '../../middleware/exportRateLimiter';
import {
  EXPORT_DATASETS,
  getExportDataset,
  type ExportDataset,
  type ExportParamSpec,
} from '../../services/export/export.manifest';
import { ExportService, type ExportQueryParams } from '../../services/export/export.service';
import { EXPORT_MAX_ROWS, EXPORT_LIMITS } from '../../constants/export.constants';
import {
  acquireExportSlot,
  releaseExportSlot,
  ExportBusyError,
  exportConcurrencySnapshot,
} from '../../services/export/export.concurrency';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const service = ExportService.getInstance();

/** No dataset comes close; this only stops a crafted `columns` list. */
const MAX_REQUESTED_COLUMNS = 200;

/**
 * Validates a raw param value against its declared spec. A value that fails is
 * dropped (never forwarded upstream), matching the silent-drop policy for
 * unknown keys. `string` is intentionally permissive — HL coin symbols contain
 * `@`, `/`, `:` etc. — so it only bounds length and blocks control chars; the
 * value is percent-encoded into the upstream query string regardless.
 */
function isValidParamValue(spec: ExportParamSpec, value: string): boolean {
  switch (spec.type) {
    case 'enum':
      return !spec.options || spec.options.includes(value);
    case 'address':
      return /^0x[a-fA-F0-9]{40}$/.test(value);
    case 'datetime':
      // ISO-8601, or an epoch timestamp in seconds/millis.
      return !Number.isNaN(Date.parse(value)) || /^\d{1,19}$/.test(value);
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(value);
    case 'string':
    default:
      // eslint-disable-next-line no-control-regex
      return value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
  }
}

/**
 * Keeps only the params the dataset declares AND whose value matches the
 * declared type, so a caller cannot smuggle arbitrary keys or malformed values
 * through to the upstream API. Unknown keys and invalid values are dropped.
 */
function pickAllowedParams(dataset: ExportDataset, query: Request['query']): ExportQueryParams {
  const specByKey = new Map(dataset.params.map((p) => [p.key, p]));
  const params: ExportQueryParams = {};
  for (const [key, value] of Object.entries(query)) {
    const spec = specByKey.get(key);
    if (!spec) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string' || raw === '') continue;
    if (!isValidParamValue(spec, raw)) continue;
    params[key] = raw;
  }
  return params;
}

/**
 * Params the dataset marks as required. Upstream answers 422 without them, and
 * a 502 relayed from there would read as "our fault" instead of "you left a
 * field empty".
 */
function missingRequiredParams(dataset: ExportDataset, params: ExportQueryParams): string[] {
  return dataset.params.filter((p) => p.required && !params[p.key]).map((p) => p.key);
}

/** Requested columns, or undefined to let the response decide. */
function parseColumns(query: Request['query']): string[] | undefined {
  const raw = query.columns;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const columns = value
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    // Bounded: the list is applied to every row, so an unbounded one turns a
    // single request into arbitrary per-row work.
    .slice(0, MAX_REQUESTED_COLUMNS);
  return columns.length > 0 ? columns : undefined;
}

function datasetFileName(dataset: ExportDataset, params: ExportQueryParams): string {
  // Allowlisted, not merely trimmed: this lands inside a double-quoted
  // Content-Disposition value, where a `"` or `;` would break the header apart.
  const stamp = (value?: string): string =>
    value ? value.slice(0, 10).replace(/[^A-Za-z0-9]/g, '') : '';
  const from = stamp(params.start_time);
  const to = stamp(params.end_time);
  const window = from || to ? `-${from || 'start'}-${to || 'now'}` : '';
  return `liquid-terminal-${dataset.id}${window}.csv`;
}

/** The catalog, so the UI can build its picker and its forms from one source. */
router.get('/datasets', marketRateLimiter, ((_req: Request, res: Response) => {
  // `upstreamPath` and `source` are stripped: the first names HypeDexer's
  // internal routes, the second tells an anonymous caller which datasets hit a
  // paid provider. This endpoint is public and the UI needs neither.
  const datasets = EXPORT_DATASETS.map(
    ({ upstreamPath: _upstreamPath, source: _source, ...rest }) => rest
  );

  res.json({
    success: true,
    data: {
      datasets,
      limits: {
        maxRows: EXPORT_MAX_ROWS,
        exportsPerWindow: EXPORT_LIMITS.MAX_EXPORTS_PER_DAY,
        windowMs: EXPORT_LIMITS.WINDOW_MS,
      },
    },
  });
}) as RequestHandler);

/** Quota state, so the button can say what it will cost before it is clicked. */
router.get(
  '/quota',
  validatePrivyToken,
  requireUser,
  marketRateLimiter,
  (async (req: Request, res: Response) => {
    const userId = req.currentUser?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated', code: 'UNAUTHENTICATED' });
      return;
    }
    const quota = await getExportQuota(userId);
    res.json({ success: true, data: quota });
  }) as RequestHandler
);

/**
 * Free preview: the first rows and the column list, so the user can shape the
 * query and pick columns without spending their single daily export.
 */
router.get(
  '/:dataset/preview',
  validatePrivyToken,
  requireUser,
  marketRateLimiter,
  exportPreviewRateLimiter,
  (async (req: Request, res: Response) => {
    const dataset = getExportDataset(String(req.params.dataset));
    if (!dataset) {
      res.status(404).json({ success: false, error: 'Unknown dataset', code: 'EXPORT_DATASET_NOT_FOUND' });
      return;
    }

    const previewParams = pickAllowedParams(dataset, req.query);
    const missingForPreview = missingRequiredParams(dataset, previewParams);
    if (missingForPreview.length > 0) {
      res.status(400).json({
        success: false,
        error: `Missing required parameter(s): ${missingForPreview.join(', ')}`,
        code: 'EXPORT_MISSING_PARAMS',
        details: { missing: missingForPreview },
      });
      return;
    }

    try {
      const preview = await service.preview(dataset, previewParams);
      res.json({ success: true, data: preview });
    } catch (error) {
      logDeduplicator.error('GET /export/:dataset/preview', {
        dataset: dataset.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Logged in full above; the client gets a generic message because the
      // upstream error text embeds the provider host and the full query string.
      res.status(502).json({
        success: false,
        error: 'Could not read this dataset upstream',
        code: 'EXPORT_PREVIEW_ERROR',
      });
    }
  }) as RequestHandler
);

/**
 * The export itself. Streams CSV as pages arrive and records the quota only
 * once the file is complete, so an upstream failure costs the user nothing.
 */
router.get(
  '/:dataset',
  validatePrivyToken,
  requireUser,
  marketRateLimiter,
  exportRateLimiter,
  (async (req: Request, res: Response) => {
    const dataset = getExportDataset(String(req.params.dataset));
    if (!dataset) {
      // Refund the reserved quota — a bad dataset id must not cost the user
      // their one export of the day. Every other exit path already releases.
      const uid = req.currentUser?.id;
      if (uid) await releaseExport(uid, req.exportReservation);
      res.status(404).json({ success: false, error: 'Unknown dataset', code: 'EXPORT_DATASET_NOT_FOUND' });
      return;
    }

    const userId = req.currentUser?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated', code: 'UNAUTHENTICATED' });
      return;
    }

    const params = pickAllowedParams(dataset, req.query);
    const missing = missingRequiredParams(dataset, params);
    if (missing.length > 0) {
      await releaseExport(userId, req.exportReservation);
      res.status(400).json({
        success: false,
        error: `Missing required parameter(s): ${missing.join(', ')}`,
        code: 'EXPORT_MISSING_PARAMS',
        details: { missing },
      });
      return;
    }

    const columns = parseColumns(req.query);
    const fileName = datasetFileName(dataset, params);

    // Queued behind the global gate. Claimed after the quota so a rejected
    // caller has not already spent their allowance, and released on every exit
    // path below.
    try {
      await acquireExportSlot();
    } catch (error) {
      await releaseExport(userId, req.exportReservation);
      if (error instanceof ExportBusyError) {
        logDeduplicator.warn('Export refused, capacity reached', exportConcurrencySnapshot());
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
        res.status(429).json({
          success: false,
          error: 'Too many exports running right now, try again shortly',
          code: 'EXPORT_BUSY',
          details: { retryAfterSeconds: error.retryAfterSeconds },
        });
        return;
      }
      throw error;
    }

    // Idempotent: the success path releases before recording the quota, so
    // anything throwing after that would reach the catch and release a second
    // time — handing capacity away that was never held.
    let slotHeld = true;
    const freeSlot = (): void => {
      if (!slotHeld) return;
      slotHeld = false;
      releaseExportSlot();
    };

    // Nothing is written until the first chunk succeeds, so an upstream error
    // on page 1 can still be reported as JSON with the right status.
    let started = false;
    let aborted = false;
    let rowCount = 0;

    try {
      const stream = service.streamCsv(dataset, params, columns);

      for await (const chunk of stream) {
        if (!started) {
          started = true;
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          res.setHeader('Cache-Control', 'no-store');
        }
        if (!res.write(chunk)) {
          // Back-pressure: wait for the socket before pulling the next page.
          // 'close' and 'error' are awaited too — on a client that vanishes
          // mid-stream 'drain' never fires, and awaiting it alone left the
          // handler (and the upstream walk) pending until process restart.
          await new Promise<void>((resolve) => {
            const done = (): void => {
              res.off('drain', done);
              res.off('close', done);
              res.off('error', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
            res.once('error', done);
          });
        }
        if (req.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }
        rowCount += 1;
      }

      if (aborted) {
        freeSlot();
        await releaseExport(userId, req.exportReservation);
        // Half a file is not an export: end the response without recording it,
        // so the user keeps the one download they are allowed per day.
        logDeduplicator.warn('Export aborted by client', {
          userId,
          dataset: dataset.id,
          rows: Math.max(0, rowCount - 1),
        });
        res.end();
        return;
      }

      if (!started) {
        freeSlot();
        await releaseExport(userId, req.exportReservation);
        res.status(404).json({
          success: false,
          error: 'No rows matched this query',
          code: 'EXPORT_EMPTY',
        });
        return;
      }

      freeSlot();
      res.end();

      // Recorded last, and only here: a download that failed or was aborted
      // must not consume a quota of one.
      await recordExport(userId, dataset.id);
      logDeduplicator.info('Export completed', {
        userId,
        dataset: dataset.id,
        // rowCount counts the header line too.
        rows: Math.max(0, rowCount - 1),
      });
    } catch (error) {
      logDeduplicator.error('GET /export/:dataset', {
        dataset: dataset.id,
        userId,
        started,
        error: error instanceof Error ? error.message : String(error),
      });

      freeSlot();
      await releaseExport(userId, req.exportReservation);

      if (started) {
        // Headers are already out; the only honest signal left is an abrupt
        // end, which turns the download into a browser error rather than a
        // truncated file the user would trust.
        res.destroy();
        return;
      }

      res.status(502).json({
        success: false,
        error: 'Export failed upstream, your quota was not spent',
        code: 'EXPORT_ERROR',
      });
    }
  }) as RequestHandler
);

export default router;
