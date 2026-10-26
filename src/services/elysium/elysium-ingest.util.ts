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
}

/**
 * Next window to ingest, or null when the cursor is already at the horizon.
 * Backfill walks forward from genesis in `stepMs` windows without overlap;
 * live mode re-reads `overlapMs` before the cursor so late rows are caught
 * (inserts are idempotent, so the overlap only costs a few duplicate reads).
 */
export function planWindow(p: PlanWindowInput): IngestWindow | null {
  const horizon = p.now.getTime() - p.settleMs;
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

function addr(v: unknown): string | null {
  const s = str(v);
  return s ? s.toLowerCase() : null;
}

function int(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function bigintString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v)).toString();
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim()).toString();
  return null;
}

function flag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Exact decimal string for `raw / 10^decimals` (no float rounding).
 * Returns null when `raw` is not a non-negative integer string.
 */
export function scaleRawAmount(raw: unknown, decimals: number | null): string | null {
  const r = typeof raw === 'number' && Number.isFinite(raw) ? BigInt(Math.trunc(raw)).toString() : str(raw);
  if (!r || !/^\d+$/.test(r)) return null;
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
  const txHash = addr(t.tx_hash);
  const from = addr(t.from_addr);
  const time = parseUpstreamTime(t.block_time);
  const block = bigintString(t.block_number);
  if (!txHash || !from || !time || block === null) return null;
  const gasUsed = bigintString(t.gas_used) ?? '0';
  const price = bigintString(t.effective_gas_price) ?? '0';
  return {
    tx_hash: txHash,
    block_number: block,
    block_time: time.toISOString(),
    from_addr: from,
    to_addr: addr(t.to_addr),
    contract_address: addr(t.contract_address),
    method_id: str(t.method_id)?.slice(0, 10) ?? null,
    tx_type: str(t.tx_type)?.toLowerCase().slice(0, 6) ?? null,
    gas_used: gasUsed,
    fee_wei: (BigInt(gasUsed) * BigInt(price)).toString(),
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

/** Map an upstream bridge transfer; rows without id or initiation time return null. */
export function normalizeBridgeTransfer(raw: unknown): BridgeRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const id = str(b.transfer_id);
  const initiated = parseUpstreamTime(b.initiated_time);
  if (!id || !initiated) return null;
  const decimals = int(b.decimals);
  let amount = scaleRawAmount(b.amount_raw, decimals);
  if (amount === null && typeof b.amount === 'number' && Number.isFinite(b.amount)) {
    amount = String(b.amount);
  }
  const duration = typeof b.duration_s === 'number' && Number.isFinite(b.duration_s) ? b.duration_s : null;
  return {
    transfer_id: id,
    direction: str(b.direction) ?? 'unknown',
    asset: str(b.asset) ?? 'unknown',
    route: str(b.route) ?? 'unknown',
    status: str(b.status) ?? 'unknown',
    symbol: str(b.symbol)?.slice(0, 64) ?? null,
    decimals,
    from_addr: addr(b.from_addr),
    to_addr: addr(b.to_addr),
    amount,
    l1_tx_hash: addr(b.l1_tx_hash),
    l2_tx_hash: addr(b.l2_tx_hash),
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

/** Map an upstream token; rows without address return null. */
export function normalizeToken(raw: unknown): TokenRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const address = addr(t.address);
  if (!address) return null;
  return {
    address,
    standard: str(t.standard) ?? 'erc20',
    name: str(t.name)?.slice(0, 256) ?? null,
    symbol: str(t.symbol)?.slice(0, 128) ?? null,
    decimals: int(t.decimals),
    origin: str(t.origin),
    first_seen: parseUpstreamTime(t.first_seen)?.toISOString() ?? null,
    transfer_count: bigintString(t.transfer_count) ?? '0',
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
  const to = addr(tx.to);
  const from = addr(tx.from);
  const hash = addr(tx.hash);
  if (!to || !from || !hash || !watched.has(to) || !(block.timestamp > 0)) return null;
  return {
    tx_hash: hash,
    block_number: String(block.number),
    block_time: new Date(block.timestamp * 1000).toISOString(),
    from_addr: from,
    to_addr: to,
  };
}
