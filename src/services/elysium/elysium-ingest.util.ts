/**
 * Pure helpers for the Elysium ingestion pipeline: window planning, upstream
 * timestamp handling and row normalisation. No I/O here so it stays unit-testable.
 */

/** First Elysium block time (upstream /stats first_block_time). */
export const ELYSIUM_GENESIS = new Date('2026-09-11T11:55:00Z');

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

export interface IngestWindow {
  start: Date;
  end: Date;
  /** True when `end` reached the settle horizon: nothing newer to fetch yet. */
  caughtUp: boolean;
}

export interface PlanWindowInput {
  /** Last fully ingested window end, or null when the stream never ran. */
  cursor: Date | null;
  /** Once true, each window re-reads `overlapMs` before the cursor. */
  backfillDone: boolean;
  now: Date;
  genesis: Date;
  /** Maximum window length. */
  stepMs: number;
  /** Replay margin before the cursor in live mode (late upstream rows). */
  overlapMs: number;
  /** Rows younger than now - settleMs are left for the next tick. */
  settleMs: number;
  /**
   * No window ends past this time, whatever the clock says: what the provider has indexed so far.
   * Absent or null when that is not known, or does not apply (a source that is always current).
   */
  ceiling?: Date | null;
}

/**
 * Next window to ingest, or null when the cursor is already at the horizon
 * (now - settleMs, or the ceiling when it is earlier).
 * Backfill walks forward from genesis in `stepMs` windows without overlap;
 * live mode re-reads `overlapMs` before the cursor so late rows are caught
 * (inserts are idempotent, so the overlap only costs a few duplicate reads).
 */
export function planWindow(p: PlanWindowInput): IngestWindow | null {
  const horizon = Math.min(p.now.getTime() - p.settleMs, p.ceiling ? p.ceiling.getTime() : Infinity);
  const base = (p.cursor ?? p.genesis).getTime();
  if (base >= horizon) return null;
  const start = p.backfillDone ? Math.max(base - p.overlapMs, p.genesis.getTime()) : base;
  const end = Math.min(base + p.stepMs, horizon);
  return { start: new Date(start), end: new Date(end), caughtUp: end >= horizon };
}

/** Upstream filter format: ISO-8601 UTC without zone suffix or millis. */
export function toUpstreamTime(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/** Upstream timestamps are UTC without a zone suffix; null/empty -> null. */
export function parseUpstreamTime(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasZone ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** UTC calendar day (YYYY-MM-DD) of a date. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/*
 * What a row may carry, checked before it reaches the database.
 *
 * The rows of a page are written in one statement, through one jsonb document: a single value
 * Postgres refuses fails the whole page, and the stream reads that page again on every run, for
 * good. Anyone can put such a value on a testnet: a token named with a NUL character or half a
 * surrogate pair (jsonb refuses both), a symbol longer than its column, a fee or a `decimals`
 * that does not fit an integer (reproduced 2026-11-11: SQLSTATE 22P05, 22P02, 22001, 22003).
 * So free text is cleaned and cut to its column, identifiers are checked for their exact shape,
 * and numbers for their range; what cannot be made to fit leaves the row out, where it is
 * counted (see IngestRejects).
 */
const UNSTORABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const TX_HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const INT8_MAX = 9_223_372_036_854_775_807n;
/** `decimals` of a token is a uint8 on chain; a contract can still answer anything. */
const DECIMALS_MAX = 255;

/** `value` without what Postgres cannot store in a text or a jsonb document (NUL, control characters, half a surrogate pair). */
export function storableText(value: string): string {
  return value.replace(UNSTORABLE, '');
}

/**
 * Free text (a name, a symbol) for a column of `max` characters: cleaned, trimmed and cut;
 * null when nothing is left. `onCut` is told when the value was longer than its column.
 */
export function boundedText(v: unknown, max: number, onCut?: (value: string) => void): string | null {
  if (typeof v !== 'string') return null;
  const clean = storableText(v).trim();
  if (clean === '') return null;
  if (clean.length <= max) return clean;
  onCut?.(clean);
  // A cut can fall inside a surrogate pair: the half left behind goes too.
  return storableText(clean.slice(0, max)).trim() || null;
}

/** A transaction hash (0x + 64 hex), lower case; null for anything else. */
export function txHash(v: unknown): string | null {
  const s = str(v)?.toLowerCase();
  return s && TX_HASH.test(s) ? s : null;
}

/** An address (0x + 40 hex), lower case; null for anything else. */
export function address(v: unknown): string | null {
  const s = str(v)?.toLowerCase();
  return s && ADDRESS.test(s) ? s : null;
}

/** True when a field that may be absent is either absent or of the right shape. */
function absentOr(v: unknown, parsed: string | null): boolean {
  return parsed !== null || v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function int(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Token decimals, null when missing or outside what a token can have. */
export function tokenDecimals(v: unknown): number | null {
  const n = int(v);
  return n !== null && n >= 0 && n <= DECIMALS_MAX ? n : null;
}

function bigintString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v)).toString();
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim()).toString();
  return null;
}

/** A non-negative integer that fits a bigint column, as a decimal string; null otherwise. */
export function int8String(v: unknown): string | null {
  const s = bigintString(v);
  return s !== null && BigInt(s) <= INT8_MAX ? s : null;
}

function flag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Exact decimal string for `raw / 10^decimals` (no float rounding).
 * Returns null when `raw` is not a non-negative integer string, or `decimals` is not a token's.
 */
export function scaleRawAmount(raw: unknown, decimals: number | null): string | null {
  const r = typeof raw === 'number' && Number.isFinite(raw) ? BigInt(Math.trunc(raw)).toString() : str(raw);
  if (!r || !/^\d+$/.test(r)) return null;
  // The scale pads the digits to `decimals` places: an absurd value would allocate that many characters.
  if (decimals !== null && decimals > DECIMALS_MAX) return null;
  const digits = r.replace(/^0+(?=\d)/, '');
  const dec = decimals && decimals > 0 ? decimals : 0;
  if (dec === 0) return digits;
  const padded = digits.padStart(dec + 1, '0');
  const intPart = padded.slice(0, padded.length - dec);
  const frac = padded.slice(padded.length - dec).replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}

/**
 * Arbitrum bridge-driven tx types (deposit, submit retryable, retry). They are
 * ingested (fees, ArbRetryableTx calls) but sent from aliased L1 addresses, so
 * the user tables (active/new/retention) leave them out, like the provider's
 * own user_transactions count does.
 */
export const BRIDGE_TX_TYPES = ['0x64', '0x68', '0x69'] as const;

export interface TxRow {
  tx_hash: string;
  block_number: string;
  block_time: string;
  from_addr: string;
  to_addr: string | null;
  contract_address: string | null;
  method_id: string | null;
  tx_type: string | null;
  gas_used: string;
  fee_wei: string;
  success: boolean;
  is_spam: boolean;
}

/** Map an upstream transaction; system txs and malformed rows return null. */
export function normalizeTx(raw: unknown): TxRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (flag(t.is_system)) return null;
  const hash = txHash(t.tx_hash);
  const from = address(t.from_addr);
  const time = parseUpstreamTime(t.block_time);
  const block = int8String(t.block_number);
  if (!hash || !from || !time || block === null) return null;
  // A target or a created contract that is there but is not an address: not a row to guess from
  // (without its target, a call would be stored as a contract creation).
  const to = address(t.to_addr);
  const created = address(t.contract_address);
  if (!absentOr(t.to_addr, to) || !absentOr(t.contract_address, created)) return null;
  const gasUsed = t.gas_used === null || t.gas_used === undefined ? '0' : int8String(t.gas_used);
  const price = bigintString(t.effective_gas_price) ?? '0';
  if (gasUsed === null) return null;
  const fee = (BigInt(gasUsed) * BigInt(price)).toString();
  // fee_wei is a numeric(38, 0).
  if (fee.length > 38) return null;
  return {
    tx_hash: hash,
    block_number: block,
    block_time: time.toISOString(),
    from_addr: from,
    to_addr: to,
    contract_address: created,
    method_id: boundedText(t.method_id, 10),
    tx_type: boundedText(t.tx_type, 6)?.toLowerCase() ?? null,
    gas_used: gasUsed,
    fee_wei: fee,
    success: flag(t.success),
    is_spam: flag(t.is_spam),
  };
}

export interface BridgeRow {
  transfer_id: string;
  direction: string;
  asset: string;
  route: string;
  status: string;
  symbol: string | null;
  decimals: number | null;
  from_addr: string | null;
  to_addr: string | null;
  amount: string | null;
  l1_tx_hash: string | null;
  l2_tx_hash: string | null;
  initiated_at: string;
  completed_at: string | null;
  duration_s: number | null;
}

/** Digits before the decimal point of elysium_bridge_transfer.amount, a numeric(96, 18). */
const BRIDGE_AMOUNT_INT_DIGITS = 78;

/**
 * Map an upstream bridge transfer; rows without a usable id or initiation time return null.
 * `onCut(field, value)` is told when a status-like field was longer than its column (a value
 * the provider added since, stored cut).
 */
export function normalizeBridgeTransfer(raw: unknown, onCut?: (field: string, value: string) => void): BridgeRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const id = str(b.transfer_id);
  const initiated = parseUpstreamTime(b.initiated_time);
  // The id is the key: one that would have to be cleaned or cut is not stored under another name.
  if (!id || id.length > 80 || storableText(id) !== id || !initiated) return null;
  const label = (field: string, max: number): string => boundedText(b[field], max, (v) => onCut?.(field, v)) ?? 'unknown';
  const decimals = tokenDecimals(b.decimals);
  let amount = scaleRawAmount(b.amount_raw, decimals);
  if (amount === null && typeof b.amount === 'number' && Number.isFinite(b.amount) && Math.abs(b.amount) < 1e60) {
    amount = String(b.amount);
  }
  const intDigits = amount === null ? 0 : (/^\d+/.exec(amount)?.[0].length ?? 0);
  if (intDigits > BRIDGE_AMOUNT_INT_DIGITS) amount = null;
  const duration = typeof b.duration_s === 'number' && Number.isFinite(b.duration_s) ? b.duration_s : null;
  return {
    transfer_id: id,
    direction: label('direction', 16),
    asset: label('asset', 16),
    route: label('route', 16),
    status: label('status', 24),
    symbol: boundedText(b.symbol, 64),
    decimals,
    from_addr: address(b.from_addr),
    to_addr: address(b.to_addr),
    amount,
    l1_tx_hash: txHash(b.l1_tx_hash),
    l2_tx_hash: txHash(b.l2_tx_hash),
    initiated_at: initiated.toISOString(),
    completed_at: parseUpstreamTime(b.completed_time)?.toISOString() ?? null,
    duration_s: duration,
  };
}

export interface TokenRow {
  address: string;
  standard: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  origin: string | null;
  first_seen: string | null;
  transfer_count: string;
}

/**
 * Map an upstream token; rows without an address return null. Names and symbols are whatever the
 * token's deployer wrote: they are cleaned and cut to their column.
 */
export function normalizeToken(raw: unknown, onCut?: (field: string, value: string) => void): TokenRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const token = address(t.address);
  if (!token) return null;
  return {
    address: token,
    standard: boundedText(t.standard, 16, (v) => onCut?.('standard', v)) ?? 'erc20',
    name: boundedText(t.name, 256),
    symbol: boundedText(t.symbol, 128),
    decimals: tokenDecimals(t.decimals),
    origin: boundedText(t.origin, 16, (v) => onCut?.('origin', v)),
    first_seen: parseUpstreamTime(t.first_seen)?.toISOString() ?? null,
    transfer_count: int8String(t.transfer_count) ?? '0',
  };
}

/** Keep the last occurrence per key (pages can overlap on shifting offsets). */
export function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const map = new Map<string, T>();
  for (const r of rows) map.set(key(r), r);
  return [...map.values()];
}

/** A transaction read from the public RPC while the provider lags: who called which contract, when. */
export interface LiveTxRow {
  tx_hash: string;
  block_number: string;
  block_time: string;
  from_addr: string;
  to_addr: string;
}

/**
 * Map an RPC block transaction; only calls to `watched` contracts are kept, everything else
 * (system txs, deployments, other contracts) returns null.
 */
export function normalizeLiveTx(
  tx: { hash?: unknown; from?: unknown; to?: unknown },
  block: { number: number; timestamp: number },
  watched: ReadonlySet<string>
): LiveTxRow | null {
  const to = address(tx.to);
  const from = address(tx.from);
  const hash = txHash(tx.hash);
  if (!to || !from || !hash || !watched.has(to) || !(block.timestamp > 0)) return null;
  return {
    tx_hash: hash,
    block_number: String(block.number),
    block_time: new Date(block.timestamp * 1000).toISOString(),
    from_addr: from,
    to_addr: to,
  };
}

/**
 * The SQLSTATE of a statement Postgres refused, when the error carries one (Prisma with the pg
 * adapter: `meta.driverAdapterError.cause.originalCode`, also printed in the message).
 */
export function pgErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } }; code?: unknown }; message?: unknown };
  const cause = e.meta?.driverAdapterError?.cause;
  for (const code of [cause?.originalCode, cause?.code, e.meta?.code]) {
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  const inMessage = typeof e.message === 'string' ? /Code: `([0-9A-Z]{5})`/.exec(e.message) : null;
  return inMessage ? inMessage[1] : null;
}

/**
 * True when Postgres refused a statement because of the data it was given (class 22, data
 * exception: a value too long, out of range, not valid text; class 23, a constraint), as
 * opposed to a lost connection, a time limit or a lock: only the first is a reason to look for
 * the row at fault. An error without a SQLSTATE is never one.
 */
export function isRowRefusal(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code !== null && (code.startsWith('22') || code.startsWith('23'));
}
