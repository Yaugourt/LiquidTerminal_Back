/**
 * What the Elysium RPC proxy lets through of the node's own error messages.
 *
 * The proxy relays the node's answer as received. For a result that is right; for an error it
 * relayed whatever the node wrote, to anyone: the node is keyed (the key is in its URL), and an
 * error can quote the URL it was called at, the provider's own upstream, a stack. An answer
 * that carries an error is small, so it is read here and its errors rewritten:
 *
 * - a message that quotes a secret, a URL or a host and port is replaced by a fixed one;
 * - any other message is kept (a builder needs "execution reverted: …"), without control
 *   characters, cut at 300 characters;
 * - `data` is kept when it is hex (the revert's payload), dropped otherwise;
 * - nothing else of the error object is relayed.
 */

/** An answer larger than this is not read for errors: it is checked for the secrets only (see holdsSecret). */
export const RPC_ERROR_CLEAN_MAX_BYTES = 64 * 1024;
const MESSAGE_MAX_CHARS = 300;
const DATA_MAX_CHARS = 16 * 1024;

const FIXED_MESSAGES: Readonly<Record<number, string>> = {
  [-32700]: 'Parse error',
  [-32600]: 'Invalid request',
  [-32601]: 'Method not found',
  [-32602]: 'Invalid params',
  [-32603]: 'Internal error',
  [-32005]: 'Limit exceeded',
};
const fixedMessage = (code: number): string => FIXED_MESSAGES[code] ?? 'Node error';

/** A URL, or a host (name or IPv4) followed by a port. */
const LOCATION = /[a-z][a-z0-9+.-]*:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/i;

/**
 * What must never leave: the node's URL, its host, and every part of its path long enough to
 * be a key. From the configured URL; empty when it does not parse.
 */
export function rpcSecrets(url: string | null): string[] {
  if (!url) return [];
  const out = new Set<string>([url]);
  try {
    const parsed = new URL(url);
    out.add(parsed.host);
    for (const part of [...parsed.pathname.split('/'), ...parsed.searchParams.values(), parsed.username, parsed.password]) {
      if (part.length >= 8) out.add(part);
    }
  } catch {
    // The whole string is the only secret known.
  }
  return [...out].filter((s) => s.length > 0);
}

function cleanMessage(message: unknown, code: number, secrets: readonly string[]): string {
  if (typeof message !== 'string') return fixedMessage(code);
  const lower = message.toLowerCase();
  if (secrets.some((secret) => lower.includes(secret.toLowerCase())) || LOCATION.test(message)) return fixedMessage(code);
  const plain = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (plain.length === 0) return fixedMessage(code);
  return plain.length > MESSAGE_MAX_CHARS ? `${plain.slice(0, MESSAGE_MAX_CHARS)}…` : plain;
}

function cleanError(error: unknown, secrets: readonly string[]): { code: number; message: string; data?: string } {
  const source = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof source.code === 'number' && Number.isInteger(source.code) ? source.code : -32603;
  const cleaned: { code: number; message: string; data?: string } = { code, message: cleanMessage(source.message, code, secrets) };
  const data = source.data;
  if (typeof data === 'string' && data.length <= DATA_MAX_CHARS && /^0x[0-9a-fA-F]*$/.test(data)) cleaned.data = data;
  return cleaned;
}

/**
 * The answer with its errors rewritten, or null when it holds none (or is not JSON-RPC that
 * can be read): it is then relayed as it is. For answers up to RPC_ERROR_CLEAN_MAX_BYTES.
 */
export function cleanRpcErrors(raw: Buffer, secrets: readonly string[]): Buffer | null {
  if (!raw.includes('"error"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  let changed = false;
  const clean = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null || !('error' in entry)) return entry;
    const answer = entry as Record<string, unknown>;
    if (answer.error === null || answer.error === undefined) return entry;
    changed = true;
    return { ...answer, error: cleanError(answer.error, secrets) };
  };
  const out = Array.isArray(parsed) ? parsed.map(clean) : clean(parsed);
  return changed ? Buffer.from(JSON.stringify(out), 'utf8') : null;
}

/**
 * True when one of `secrets` appears in the answer, across its chunks. For the answers too
 * large to be read for errors: megabytes of results are not parsed, and still must not carry
 * the key out.
 */
export function holdsSecret(chunks: readonly Buffer[], secrets: readonly string[]): boolean {
  const needles = secrets.map((secret) => Buffer.from(secret, 'utf8')).filter((needle) => needle.length > 0);
  if (needles.length === 0) return false;
  const longest = Math.max(...needles.map((needle) => needle.length));
  let tail: Buffer = Buffer.alloc(0);
  for (const chunk of chunks) {
    // The end of the previous chunk with the start of this one: a secret cut in two by a chunk boundary.
    const seam = tail.length > 0 ? Buffer.concat([tail, chunk.subarray(0, longest - 1)]) : null;
    for (const needle of needles) {
      if (chunk.includes(needle) || (seam !== null && seam.includes(needle))) return true;
    }
    tail = chunk.length >= longest - 1 ? chunk.subarray(chunk.length - (longest - 1)) : Buffer.concat([tail, chunk]).subarray(-(longest - 1));
  }
  return false;
}
