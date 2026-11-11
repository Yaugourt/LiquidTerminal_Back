/**
 * What the Elysium RPC proxy lets through of the node's own error messages.
 *
 * The proxy relays the node's answer as received. For a result that is right; for an error it
 * relayed whatever the node wrote, to anyone: the node is keyed (the key is in its URL), and an
 * error can quote the URL it was called at, the provider's own upstream, a stack. Two guards:
 *
 * 1. No answer leaves with the node's URL, host or key in it, whatever its size and wherever
 *    in it they are (holdsSecret, on the bytes as they leave).
 * 2. An answer of up to 256 KB that carries an error is read, and its errors rewritten
 *    (cleanRpcErrors), the ones a simulation reports for each of its calls included:
 *    - a message that quotes a secret, a URL or a host and port is replaced by a fixed one;
 *    - any other message is kept (a builder needs "execution reverted: …"), without control
 *      characters, cut at 300 characters;
 *    - `data` is kept when it is hex (the revert's payload), dropped otherwise;
 *    - nothing else of the error object, nor of the answer that carries it, is relayed.
 *
 * A larger answer (a batch of big reads in which one call failed) is not read: megabytes are
 * not parsed on the request path. Its errors keep the node's wording; guard 1 still holds.
 */

/** An answer larger than this is not read for errors: it is checked for the secrets only (see holdsSecret). */
export const RPC_ERROR_CLEAN_MAX_BYTES = 256 * 1024;
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
  // The secrets are looked for in the whole message (a plain search, linear in its length).
  const lower = message.toLowerCase();
  if (secrets.some((secret) => lower.includes(secret.toLowerCase()))) return fixedMessage(code);
  // Only what can be relayed is looked at further: the pattern below can take a time that grows
  // with the square of what it is given, and a contract can revert with a message of 60 KB
  // (measured: 1.4 to 2 s of the event loop on the whole message).
  const head = message.slice(0, MESSAGE_MAX_CHARS + 1);
  if (LOCATION.test(head)) return fixedMessage(code);
  const plain = head.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
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
  /**
   * A simulation (eth_simulateV1) answers a result, with an error of its own for each call
   * that failed, in result[].calls[].error: the node's wording too.
   */
  const cleanSimulated = (result: unknown): unknown => {
    if (!Array.isArray(result)) return result;
    return result.map((block: unknown) => {
      if (typeof block !== 'object' || block === null || !Array.isArray((block as { calls?: unknown }).calls)) return block;
      const calls = (block as { calls: unknown[] }).calls.map((call: unknown) => {
        if (typeof call !== 'object' || call === null) return call;
        const own = (call as { error?: unknown }).error;
        if (own === null || own === undefined) return call;
        changed = true;
        return { ...(call as Record<string, unknown>), error: cleanError(own, secrets) };
      });
      return { ...(block as Record<string, unknown>), calls };
    });
  };
  const clean = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const answer = entry as Record<string, unknown>;
    if (answer.error === null || answer.error === undefined) {
      if (!('result' in answer)) return entry;
      const result = cleanSimulated(answer.result);
      return result === answer.result ? entry : { ...answer, result };
    }
    changed = true;
    // The answer is rebuilt from what a JSON-RPC error answer holds: nothing else the node added leaves.
    return { jsonrpc: answer.jsonrpc ?? '2.0', id: answer.id ?? null, error: cleanError(answer.error, secrets) };
  };
  const out = Array.isArray(parsed) ? parsed.map(clean) : clean(parsed);
  return changed ? Buffer.from(JSON.stringify(out), 'utf8') : null;
}

/**
 * True when one of `secrets` appears in the answer, across its chunks. Run on every answer as
 * it leaves, whatever its size: megabytes of results are not parsed, and still must not carry
 * the key out; and a small answer can quote it outside an error (another field, a result, a
 * body that is not the JSON it looks like). A search of the bytes, exact: the key is looked
 * for as it is written, the host as the URL has it.
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
