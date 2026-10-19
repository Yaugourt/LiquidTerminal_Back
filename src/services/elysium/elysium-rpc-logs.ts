/**
 * Elysium logs read straight from a public RPC (eth_getLogs), as a fallback
 * for the log-based ingest streams (dex, launchpad) while the provider's
 * indexer lags behind the chain. Logs come back in the provider's /logs row
 * shape, so the existing decoders read them unchanged.
 *
 * The streams plan their windows in time; the RPC filters by block. A time
 * is turned into a block by interpolation search over block timestamps
 * (a handful of calls, memoised), and logs outside the window are dropped.
 */
import { logDeduplicator } from '../../utils/logDeduplicator';

const DEFAULT_RPC_URL = 'https://testnet-rpc.elysium.kinetiq.xyz';
/** eth_getLogs answers 200k-block ranges in ~2.5 s (measured 2026-10-19); stay well under. */
const LOGS_BLOCK_SPAN = 100_000;
/** The public RPC refuses part of a burst: one call at a time, with a gap. */
const MIN_CALL_GAP_MS = process.env.NODE_ENV === 'test' ? 0 : 250;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 20_000;
/** Interpolation stops once the bracket is this narrow; the window filter does the rest. */
const SEARCH_TOLERANCE_BLOCKS = 2;
/** Interpolation and bisection alternate, so ~2 x log2(blocks) steps always converge. */
const SEARCH_MAX_STEPS = 64;
const MEMO_MAX = 512;

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockTimestamp?: string;
  removed?: boolean;
}

/** One log in the provider's /logs row shape. */
export interface UpstreamLogRow {
  block_time: string;
  block_number: number;
  log_index: number;
  tx_hash: string;
  address: string;
  topic0: string;
  topic1: string;
  topic2: string;
  topic3: string;
  data: string;
}

/** RPC log -> provider row; null when the RPC left out the block timestamp or the log was reorged out. */
export function toUpstreamLog(l: RpcLog): UpstreamLogRow | null {
  if (l.removed || !l.blockTimestamp || !l.topics?.length) return null;
  const seconds = parseInt(l.blockTimestamp, 16);
  if (!Number.isFinite(seconds)) return null;
  return {
    block_time: new Date(seconds * 1000).toISOString(),
    block_number: parseInt(l.blockNumber, 16),
    log_index: parseInt(l.logIndex, 16),
    tx_hash: l.transactionHash.toLowerCase(),
    address: l.address.toLowerCase(),
    topic0: l.topics[0] ?? '',
    topic1: l.topics[1] ?? '',
    topic2: l.topics[2] ?? '',
    topic3: l.topics[3] ?? '',
    data: l.data,
  };
}

export class ElysiumRpcLogs {
  private static instance: ElysiumRpcLogs;

  private readonly url = (process.env.ELYSIUM_RPC_URL ?? DEFAULT_RPC_URL).trim();
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Block number -> timestamp (seconds), for the interpolation search. */
  private readonly blockTimes = new Map<number, number>();
  /** Time (seconds) -> block, so every topic of one window shares the same two searches. */
  private readonly blockAt = new Map<number, number>();

  public static getInstance(): ElysiumRpcLogs {
    if (!ElysiumRpcLogs.instance) ElysiumRpcLogs.instance = new ElysiumRpcLogs();
    return ElysiumRpcLogs.instance;
  }

  /** Every log with this topic0 in [start, end), in /logs row shape, oldest first. */
  public async getLogs(topic0: string, start: Date, end: Date): Promise<UpstreamLogRow[]> {
    const from = await this.blockAtOrBefore(start.getTime() / 1000);
    const to = (await this.blockAtOrBefore(end.getTime() / 1000)) + 1;
    const rows: UpstreamLogRow[] = [];
    for (let lo = from; lo <= to; lo += LOGS_BLOCK_SPAN) {
      const hi = Math.min(to, lo + LOGS_BLOCK_SPAN - 1);
      const logs = await this.call<RpcLog[]>('eth_getLogs', [
        { fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${hi.toString(16)}`, topics: [topic0] },
      ]);
      for (const l of logs) {
        const row = toUpstreamLog(l);
        if (!row) continue;
        const t = Date.parse(row.block_time);
        if (t >= start.getTime() && t < end.getTime()) rows.push(row);
      }
    }
    return rows;
  }

  /** Last block whose timestamp is at or before `ts` (seconds); only past times are memoised. */
  private async blockAtOrBefore(ts: number): Promise<number> {
    const key = Math.floor(ts);
    const known = this.blockAt.get(key);
    if (known !== undefined) return known;
    const block = await this.searchBlock(key);
    // A time at or past the head can still gain blocks: never memoise it.
    if (block < (await this.headBlock())) {
      if (this.blockAt.size >= MEMO_MAX) this.blockAt.clear();
      this.blockAt.set(key, block);
    }
    return block;
  }

  private headCache: { at: number; block: number } | null = null;

  /** Current head, read at most every few seconds. */
  private async headBlock(): Promise<number> {
    if (this.headCache && Date.now() - this.headCache.at < 5_000) return this.headCache.block;
    const block = parseInt(await this.call<string>('eth_blockNumber', []), 16);
    this.headCache = { at: Date.now(), block };
    return block;
  }

  private async searchBlock(ts: number): Promise<number> {
    let hi = await this.headBlock();
    let hiT = await this.blockTime(hi);
    if (ts >= hiT) return hi;
    // Block 0 carries a zero timestamp on Arbitrum chains: search from block 1.
    let lo = 1;
    let loT = await this.blockTime(lo);
    if (ts <= loT) return lo;
    for (let step = 0; step < SEARCH_MAX_STEPS && hi - lo > SEARCH_TOLERANCE_BLOCKS; step++) {
      // Interpolate on time on even steps, bisect on odd ones: uneven block times cannot stall it.
      const guess =
        step % 2 === 0 ? lo + Math.round(((ts - loT) / (hiT - loT)) * (hi - lo)) : lo + Math.floor((hi - lo) / 2);
      const mid = Math.min(hi - 1, Math.max(lo + 1, guess));
      const midT = await this.blockTime(mid);
      if (midT <= ts) {
        lo = mid;
        loT = midT;
      } else {
        hi = mid;
        hiT = midT;
      }
    }
    return lo;
  }

  private async blockTime(n: number): Promise<number> {
    const known = this.blockTimes.get(n);
    if (known !== undefined) return known;
    const block = await this.call<{ timestamp: string } | null>('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
    if (!block) throw new Error(`Elysium RPC: block ${n} not found`);
    const t = parseInt(block.timestamp, 16);
    if (this.blockTimes.size >= MEMO_MAX) this.blockTimes.clear();
    this.blockTimes.set(n, t);
    return t;
  }

  /** Serialised JSON-RPC call with a minimum gap and retries on rate limits and timeouts. */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await this.wait();
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { message?: string } };
        if (body.error) throw new Error(body.error.message ?? 'RPC error');
        return body.result as T;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    logDeduplicator.warn('Elysium RPC: call failed', {
      method,
      errorType: lastError instanceof Error ? lastError.name : typeof lastError,
    });
    throw lastError instanceof Error ? lastError : new Error(`Elysium RPC: ${method} failed`);
  }

  private wait(): Promise<void> {
    const turn = this.chain.then(async () => {
      const delay = this.nextAt - Date.now();
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      this.nextAt = Date.now() + MIN_CALL_GAP_MS;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}
