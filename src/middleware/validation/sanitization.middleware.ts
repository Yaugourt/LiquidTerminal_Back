import { Request, Response, NextFunction } from 'express';
import sanitizeHtml from 'sanitize-html';

/**
 * Hard cap on query keys. Real requests carry a handful; anything past this is
 * an attempt to weaponise the Express 5 `req.query` getter (see below). Reject
 * rather than process.
 */
const MAX_QUERY_KEYS = 50;

/** Bounds the recursion in `sanitizeObject` so a deeply nested body can't blow the stack. */
const MAX_BODY_DEPTH = 8;

/**
 * Middleware de sanitization pour nettoyer les entrées utilisateur
 * Ce middleware doit être appliqué avant la validation
 */
export const sanitizeInput = (req: Request, res: Response, next: NextFunction): void => {
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
      sanitizedQuery[key] = typeof value === 'string' ? sanitizeString(value) : value;
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
    Object.keys(req.params).forEach(key => {
      if (typeof req.params[key] === 'string') {
        req.params[key] = sanitizeString(req.params[key] as string);
      }
    });
  }

  // Sanitization personnalisée pour le corps de la requête (bounded by the
  // express.json() body limit set in app.ts).
  if (req.body) {
    sanitizeObject(req.body, 0);
  }

  next();
};

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
      return text.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
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
 */
function sanitizeObject(obj: any, depth: number): void {
  if (!obj || typeof obj !== 'object' || depth > MAX_BODY_DEPTH) {
    return;
  }

  Object.keys(obj).forEach(key => {
    if (typeof obj[key] === 'string') {
      obj[key] = sanitizeString(obj[key]);
    } else if (typeof obj[key] === 'object') {
      sanitizeObject(obj[key], depth + 1);
    }
  });
}
