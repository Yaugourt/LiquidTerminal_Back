import { Request, Response, NextFunction } from 'express';
import sanitizeHtml from 'sanitize-html';
import { ClientBudget } from '../../utils/clientBudget';
import { rateLimitKeyForIp } from '../../utils/client-ip';
import { positiveIntEnv } from '../../utils/env';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Hard cap on query keys. Real requests carry a handful; anything past this is
 * an attempt to weaponise the Express 5 `req.query` getter (see below). Reject
 * rather than process.
 */
const MAX_QUERY_KEYS = 50;

/** Bounds the recursion in `sanitizeObject` so a deeply nested body can't blow the stack. */
const MAX_BODY_DEPTH = 8;

/** A string with none of these has no tag and no entity: the HTML parser would hand it back as it is. */
const MARKUP = /[<>&]/;
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;

/**
 * HTML parsing one client may ask for, in units, per 10 s window.
 *
 * This middleware runs before every route, so before every route limiter, and
 * the HTML parser is its expensive part: up to 9 microseconds to start on a
 * string, up to 0.4 per `<`, and about 0.03 per character inside a long tag
 * (measured 2026-11-11). A 74 kB body of 12,375 strings `"<a>"` held the event
 * loop 90 ms, a 16 kB query string of `<` about 6 ms, on any path, as often as
 * the caller liked.
 *
 * So only the strings that carry markup (`<`, `>` or `&`) go to the parser,
 * and what they cost is counted per client: a unit is one string, plus one per
 * 8 markup characters, plus one per 256 characters (about 9 microseconds a
 * unit at worst, whatever the shape: many small strings, one string of `<`, or
 * one long tag with thousands of attributes). The largest legitimate case is a
 * bulk import of 1,000 wallets whose names all carry a `&` or a `<`: 1,000
 * units. 1,536 a window is about 14 ms of parsing per client per 10 s,
 * whatever it sends; a request that needs more than a whole window is refused
 * for good (400), one that finds the window spent is told when to retry (429).
 * In memory: it holds when Redis is down.
 */
const SANITIZE_WINDOW_MS = 10_000;
const sanitizeBudget = new ClientBudget(positiveIntEnv('SANITIZE_UNITS_PER_WINDOW', 1536), SANITIZE_WINDOW_MS);
/**
 * Units parsed in one go (about a millisecond). A request that needs more
 * gives the event loop back between slices, so even the largest accepted one
 * never holds every other request behind its whole parsing.
 */
const SANITIZE_SLICE_UNITS = 128;

/** A string waiting for the HTML parser, what parsing it weighs, and where its result goes. */
interface PendingString {
  holder: Record<string, unknown>;
  key: string;
  value: string;
  units: number;
}

/** What one request asks of the HTML parser. */
interface ParseWork {
  pending: PendingString[];
  units: number;
}

/**
 * Middleware de sanitization pour nettoyer les entrées utilisateur
 * Ce middleware doit être appliqué avant la validation
 */
export const sanitizeInput = (req: Request, res: Response, next: NextFunction): void => {
  const work: ParseWork = { pending: [], units: 0 };

  // Express 5 exposes `req.query` as a getter that RE-PARSES the raw query
  // string on every property access. The previous loop read it ~3× per key, so
  // n keys cost O(n²) parses — ~600 ms of CPU for a 1000-key URL, an
  // unauthenticated single-request core-killer. Two things go wrong at once and
  // both are fixed here:
  //   1. Snapshot the parsed object into a local ONCE, then iterate that local
  //      (O(n), not O(n²)).
  //   2. Assignments to `req.query[key]` used to hit the getter's throwaway
  //      object, so query sanitization was silently a no-op. Redefining
  //      `req.query` as a concrete data property makes the sanitized values
  //      actually persist AND makes every downstream read O(1).
  const rawQuery = req.query as Record<string, unknown> | undefined;
  if (rawQuery) {
    const keys = Object.keys(rawQuery);
    if (keys.length > MAX_QUERY_KEYS) {
      res.status(400).json({
        success: false,
        error: 'Too many query parameters',
        code: 'TOO_MANY_QUERY_PARAMS',
      });
      return;
    }
    const sanitizedQuery: Record<string, unknown> = {};
    for (const key of keys) {
      const value = rawQuery[key];
      if (typeof value === 'string') collect(work, sanitizedQuery, key, value);
      else sanitizedQuery[key] = value;
    }
    // Shadow the prototype getter with an own value property (Express 5 removed
    // the setter, so a plain assignment would throw).
    Object.defineProperty(req, 'query', {
      value: sanitizedQuery,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // Sanitization personnalisée pour les paramètres de route (bounded by the
  // route definition, always a handful of keys).
  if (req.params) {
    const params = req.params as Record<string, unknown>;
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (typeof value === 'string') collect(work, params, key, value);
    }
  }

  // Sanitization personnalisée pour le corps de la requête (bounded by the
  // body limit of the parsers and by the request body budget in front of them).
  if (req.body) {
    sanitizeObject(req.body, 0, work);
  }

  if (work.pending.length > 0) {
    if (work.units > sanitizeBudget.limit) {
      res.status(400).json({
        success: false,
        error: 'Too much markup in the request',
        code: 'INPUT_TOO_COMPLEX',
      });
      return;
    }
    const client = rateLimitKeyForIp(req.ip ?? '');
    if (!sanitizeBudget.take(client, work.units)) {
      const retryAfter = sanitizeBudget.retryAfterS();
      logDeduplicator.warn('Sanitizer budget spent', { ip: client });
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Rate limit exceeded', message: 'Too much markup in recent requests', retryAfter });
      return;
    }
    parsePending(work.pending, 0, next);
    return;
  }

  next();
};

/**
 * Runs the HTML parser over `pending` from `index`, a slice at a time, then
 * calls `next`. The common request (a few strings with markup) is done in the
 * first slice, synchronously, as before.
 */
function parsePending(pending: PendingString[], index: number, next: NextFunction): void {
  try {
    let units = 0;
    while (index < pending.length && units < SANITIZE_SLICE_UNITS) {
      const { holder, key, value } = pending[index];
      holder[key] = sanitizeString(value);
      units += pending[index].units;
      index += 1;
    }
  } catch (error) {
    // Later slices run outside Express's own try/catch: hand the error over.
    next(error);
    return;
  }
  if (index < pending.length) setImmediate(parsePending, pending, index, next);
  else next();
}

/**
 * Cleans `value` in place when it carries no markup (no parser needed), or
 * queues it for the HTML parser and counts what that will cost.
 */
function collect(work: ParseWork, holder: Record<string, unknown>, key: string, value: string): void {
  if (!MARKUP.test(value)) {
    holder[key] = cleanText(value);
    return;
  }
  let markup = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // < > &
    if (c === 60 || c === 62 || c === 38) markup++;
  }
  const units = 1 + Math.floor(markup / 8) + Math.floor(value.length / 256);
  work.units += units;
  work.pending.push({ holder, key, value, units });
}

/**
 * What `sanitizeString` does to a string without `<`, `>` or `&`: with no tag
 * to drop and no entity to decode, the HTML parser returns the text through
 * its control-character filter and nothing else. Same result, without the parser.
 */
function cleanText(text: string): string {
  return text.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

/**
 * Fonction utilitaire pour sanitizer une chaîne de caractères
 * @param str Chaîne à sanitizer
 * @returns Chaîne sanitizée
 */
function sanitizeString(str: string): string {
  // Utiliser sanitize-html pour nettoyer le HTML
  str = sanitizeHtml(str, {
    allowedTags: [], // Ne pas autoriser de tags HTML
    allowedAttributes: {}, // Ne pas autoriser d'attributs
    disallowedTagsMode: 'discard', // Supprimer les tags, pas encoder
    textFilter: (text: string) => {
      // Supprimer les caractères de contrôle
      return text.replace(CONTROL_CHARS, '');
    }
  });

  // Décoder uniquement &amp; pour garder les & dans les titres (safe)
  // Ne PAS décoder < > pour éviter les risques XSS
  str = str.replace(/&amp;/g, '&');

  // Supprimer les espaces multiples
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Fonction utilitaire pour sanitizer un objet récursivement
 * @param obj Objet à sanitizer
 * @param depth Profondeur courante (garde-fou anti stack-overflow)
 * @param work Ce que la requête demande au parseur HTML
 */
function sanitizeObject(obj: unknown, depth: number, work: ParseWork): void {
  if (!obj || typeof obj !== 'object' || depth > MAX_BODY_DEPTH) {
    return;
  }
  // Past a whole window of parsing the request is refused: nothing left to look for.
  if (work.units > sanitizeBudget.limit) return;

  const holder = obj as Record<string, unknown>;
  for (const key of Object.keys(holder)) {
    const value = holder[key];
    if (typeof value === 'string') {
      collect(work, holder, key, value);
      if (work.units > sanitizeBudget.limit) return;
    } else if (typeof value === 'object') {
      sanitizeObject(value, depth + 1, work);
    }
  }
}
