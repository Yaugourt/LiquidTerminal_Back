import express from 'express';

/**
 * JSON and form body parsers, mounted globally before the sanitizer.
 *
 * Explicit limits: bodies here are small (uploads go through multer, not these
 * parsers), so a tight cap bounds the per-request work the sanitizer does.
 *
 * `inflate: false` answers 415 to a compressed request body. No client of ours
 * sends one, and these parsers run before any auth: decoding gzip/Brotli here
 * would hand attacker bytes to zlib on every route (Node CVE-2026-111497).
 */
export const jsonBodyParser = express.json({ limit: '100kb', inflate: false });

export const urlencodedBodyParser = express.urlencoded({
  extended: true,
  limit: '100kb',
  parameterLimit: 100,
  inflate: false,
});
