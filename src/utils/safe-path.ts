import path from 'path';
import fs from 'fs';

/**
 * Resolves `filePath` and asserts it lives strictly under `baseDir`.
 * Defensive guard against directory traversal when a file path crosses a trust
 * boundary (route handler → service, queue → worker, etc.). Pass an absolute or
 * cwd-relative `baseDir`; both are normalized before comparison.
 *
 * Throws if the resolved path escapes the base, points to a symlink, or does
 * not exist.
 */
export function assertSafeUploadPath(filePath: string, baseDir: string): string {
  const absoluteBase = path.resolve(baseDir);
  const resolved = path.resolve(filePath);

  // Use `<base>/` for the prefix check so `<base>-other/foo` is rejected.
  const baseWithSep = absoluteBase.endsWith(path.sep) ? absoluteBase : absoluteBase + path.sep;
  if (resolved !== absoluteBase && !resolved.startsWith(baseWithSep)) {
    throw new UnsafePathError(`Path ${filePath} resolves outside of ${baseDir}`);
  }

  // Refuse symlinks — an attacker who can plant a symlink in the upload dir
  // could otherwise redirect reads to arbitrary files.
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (err) {
    throw new UnsafePathError(
      `Path ${filePath} cannot be stat'd: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new UnsafePathError(`Path ${filePath} is a symlink, refusing to read`);
  }
  if (!stats.isFile()) {
    throw new UnsafePathError(`Path ${filePath} is not a regular file`);
  }

  return resolved;
}

export class UnsafePathError extends Error {
  public readonly code = 'UNSAFE_PATH';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}
