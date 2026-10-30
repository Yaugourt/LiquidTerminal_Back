/**
 * Read-only HyperEVM calls to the Hyperliquid Names contracts, so expiries and
 * profiles cost their REST API nothing. Raw JSON-RPC (the back has no EVM
 * library); expiries go through Multicall3 because the public RPC caps JSON-RPC
 * batches at 20 requests.
 *
 * The contracts are not verified; the selectors below were checked against the
 * deployed bytecode. The Registrator is versioned, so its address is read from
 * their Router instead of being hardcoded.
 */

const RPC_URL = process.env.HYPEREVM_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const TIMEOUT_MS = 10_000;

/** Router of Hyperliquid Names: points to the live Registrator. */
const ROUTER = '0x25d1971D6dc9812EA1111662008f07735C74Bff5';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const SEL_CURRENT_REGISTRATOR = '0x082dfe4e'; // getCurrentRegistrator()
const SEL_GET_EXPIRY = '0x52cc3b21'; // getExpiry(bytes32)
const SEL_FULL_RECORD = '0x4b32f722'; // getFullRecordJSON(bytes32)
const SEL_AGGREGATE3 = '0x82ad56cb'; // aggregate3((address,bool,bytes)[])

/** Expiry lookups per Multicall3 call. */
export const EXPIRY_CHUNK = 500;

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDR_RE = /^0x[0-9a-f]{40}$/i;

async function ethCall(to: string, data: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      signal: ctrl.signal,
    });
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (typeof body.result !== 'string' || !body.result.startsWith('0x')) {
      throw new Error(`eth_call failed: ${body.error?.message ?? res.status}`);
    }
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

const word = (hex: string, i: number): string => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const wordNum = (hex: string, i: number): number => Number(BigInt('0x' + (word(hex, i) || '0')));
const pad32 = (n: number): string => n.toString(16).padStart(64, '0');

/** Address of the live Registrator, as their Router reports it. */
export async function currentRegistrator(): Promise<string> {
  const out = await ethCall(ROUTER, SEL_CURRENT_REGISTRATOR);
  const addr = '0x' + word(out, 0).slice(24);
  if (!ADDR_RE.test(addr) || /^0x0{40}$/.test(addr)) throw new Error('no registrator');
  return addr;
}

/**
 * Expiry (Unix seconds) of each namehash, null when a call failed. One
 * Multicall3 aggregate3 per EXPIRY_CHUNK names, allowFailure set on each call.
 */
export async function expiries(registrator: string, namehashes: string[]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let i = 0; i < namehashes.length; i += EXPIRY_CHUNK) {
    out.push(...(await expiryChunk(registrator, namehashes.slice(i, i + EXPIRY_CHUNK))));
  }
  return out;
}

async function expiryChunk(registrator: string, hashes: string[]): Promise<(number | null)[]> {
  if (!hashes.length) return [];
  // aggregate3(Call3[]): every Call3 is (target, allowFailure, 36-byte callData), so each
  // encoded tuple has the same size: 3 head words + length word + 2 data words.
  const TUPLE = 6 * 32;
  const target = pad32(0).slice(0, 24) + registrator.slice(2).toLowerCase();
  let data = SEL_AGGREGATE3 + pad32(32) + pad32(hashes.length);
  for (let i = 0; i < hashes.length; i++) data += pad32(hashes.length * 32 + i * TUPLE);
  for (const h of hashes) {
    const hash = HASH_RE.test(h) ? h.slice(2).toLowerCase() : '0'.repeat(64);
    data += target + pad32(1) + pad32(96) + pad32(36) + (SEL_GET_EXPIRY.slice(2) + hash).padEnd(128, '0');
  }
  const res = await ethCall(MULTICALL3, data);

  // Result[] = (bool success, bytes returnData)[]; offsets count from the start of the array body.
  const arrayAt = wordNum(res, 0) / 32;
  const n = wordNum(res, arrayAt);
  if (n !== hashes.length) throw new Error(`multicall returned ${n} results for ${hashes.length}`);
  const body = arrayAt + 1;
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const at = body + wordNum(res, body + i) / 32;
    const ok = wordNum(res, at) === 1;
    const len = wordNum(res, at + wordNum(res, at + 1) / 32);
    const value = ok && len === 32 ? wordNum(res, at + wordNum(res, at + 1) / 32 + 1) : NaN;
    out.push(Number.isSafeInteger(value) && value > 0 ? value : null);
  }
  return out;
}

/** Their getFullRecordJSON for one namehash, parsed (same shape as the REST full_record). */
export async function fullRecord(registrator: string, namehash: string): Promise<{ records: Record<string, string>; expiry: number | null }> {
  if (!HASH_RE.test(namehash)) throw new Error('bad namehash');
  const res = await ethCall(registrator, SEL_FULL_RECORD + namehash.slice(2).toLowerCase());
  const at = wordNum(res, 0) / 32;
  const len = wordNum(res, at);
  if (len > 64_000) throw new Error('record too large');
  const json = Buffer.from(res.slice(2 + (at + 1) * 64, 2 + (at + 1) * 64 + len * 2), 'hex').toString('utf8');
  const parsed = JSON.parse(json) as { name?: { expiry?: string }; data?: { records?: Record<string, unknown> } };
  const records: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data?.records ?? {})) if (typeof v === 'string') records[k] = v;
  const expiry = Number(parsed.name?.expiry);
  return { records, expiry: Number.isSafeInteger(expiry) && expiry > 0 ? expiry : null };
}
