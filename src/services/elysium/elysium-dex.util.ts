/**
 * Pure decoders for the Uniswap V2 / V3 logs ingested from Elysium (/logs).
 * No I/O so they stay unit-testable.
 */
import { address, int8String, parseUpstreamTime, txHash } from './elysium-ingest.util';

/** Event signatures (topic0) tracked by the DEX stream. */
export const DEX_TOPICS = {
  v2PairCreated: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  v3PoolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  v2Swap: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  v3Swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
} as const;

export type DexTopic = keyof typeof DEX_TOPICS;

const TWO_255 = BigInt(2) ** BigInt(255);
const TWO_256 = BigInt(2) ** BigInt(256);
const HEX32 = /^0x[0-9a-f]{64}$/;
const INT4_MAX = 2_147_483_647;
const UINT24_MAX = 0xffffff;

export interface DexPoolRow {
  pool: string;
  factory: string;
  version: 'v2' | 'v3';
  token0: string;
  token1: string;
  fee: number | null;
  created_at: string;
  block_number: string;
  tx_hash: string;
}

export interface DexSwapRow {
  tx_hash: string;
  log_index: number;
  pool: string;
  version: 'v2' | 'v3';
  block_time: string;
  block_number: string;
  sender: string;
  recipient: string;
  /** Signed raw integers as decimal strings (positive = paid into the pool). */
  amount0: string;
  amount1: string;
}

interface RawLog {
  block_time: unknown;
  block_number: unknown;
  log_index: unknown;
  tx_hash: unknown;
  address: unknown;
  topic0: unknown;
  topic1: unknown;
  topic2: unknown;
  topic3: unknown;
  data: unknown;
}

function lower(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null;
}

/** Address packed in a 32-byte topic (last 20 bytes). */
export function topicAddress(topic: unknown): string | null {
  const t = lower(topic);
  if (!t || !HEX32.test(t)) return null;
  return `0x${t.slice(-40)}`;
}

/** 32-byte word `i` of ABI data, as hex without 0x, or null if out of range. */
export function dataWord(data: string, i: number): string | null {
  const start = 2 + i * 64;
  const w = data.slice(start, start + 64);
  return w.length === 64 && /^[0-9a-f]+$/.test(w) ? w : null;
}

export function wordUint(word: string): bigint {
  return BigInt(`0x${word}`);
}

/** Two's complement int256. */
export function wordInt(word: string): bigint {
  const v = BigInt(`0x${word}`);
  return v >= TWO_255 ? v - TWO_256 : v;
}

function wordAddress(word: string): string {
  return `0x${word.slice(-40)}`;
}

function base(raw: unknown): {
  l: RawLog;
  data: string;
  time: Date;
  block: string;
  txHash: string;
  address: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as RawLog;
  const data = lower(l.data) ?? '0x';
  const time = parseUpstreamTime(l.block_time);
  // Checked for their exact shape: these go to fixed-width columns (see elysium-ingest.util).
  const hash = txHash(l.tx_hash);
  const emitter = address(l.address);
  const block = int8String(l.block_number);
  if (!time || !hash || !emitter || block === null || !data.startsWith('0x')) return null;
  return { l, data, time, block, txHash: hash, address: emitter };
}

/** A log index as stored (an integer column); null for anything else. */
export function logIndexOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= INT4_MAX ? n : null;
}

/** V2 PairCreated(token0 indexed, token1 indexed, pair, allPairsLength) or V3 PoolCreated(token0, token1, fee indexed; tickSpacing, pool). */
export function decodePoolCreated(raw: unknown): DexPoolRow | null {
  const b = base(raw);
  if (!b) return null;
  const topic0 = lower(b.l.topic0);
  const token0 = topicAddress(b.l.topic1);
  const token1 = topicAddress(b.l.topic2);
  if (!token0 || !token1) return null;
  if (topic0 === DEX_TOPICS.v2PairCreated) {
    const w0 = dataWord(b.data, 0);
    if (!w0) return null;
    return {
      pool: wordAddress(w0),
      factory: b.address,
      version: 'v2',
      token0,
      token1,
      fee: null,
      created_at: b.time.toISOString(),
      block_number: b.block,
      tx_hash: b.txHash,
    };
  }
  if (topic0 === DEX_TOPICS.v3PoolCreated) {
    const w1 = dataWord(b.data, 1);
    const feeTopic = lower(b.l.topic3);
    if (!w1 || !feeTopic || !HEX32.test(feeTopic)) return null;
    // A uint24 on a real pool; the topic is 32 bytes and anyone can emit this event with any value.
    const fee = Number(BigInt(feeTopic));
    return {
      pool: wordAddress(w1),
      factory: b.address,
      version: 'v3',
      token0,
      token1,
      fee: fee <= UINT24_MAX ? fee : null,
      created_at: b.time.toISOString(),
      block_number: b.block,
      tx_hash: b.txHash,
    };
  }
  return null;
}

/**
 * V2 Swap(sender indexed, amount0In, amount1In, amount0Out, amount1Out, to indexed)
 * -> amountX = in - out. V3 Swap(sender indexed, recipient indexed, int256 amount0,
 * int256 amount1, ...) -> already pool-signed.
 */
export function decodeSwap(raw: unknown): DexSwapRow | null {
  const b = base(raw);
  if (!b) return null;
  const logIndex = logIndexOf(b.l.log_index);
  if (logIndex === null) return null;
  const topic0 = lower(b.l.topic0);
  const sender = topicAddress(b.l.topic1);
  const recipient = topicAddress(b.l.topic2);
  if (!sender || !recipient) return null;
  const words = [0, 1, 2, 3].map((i) => dataWord(b.data, i));
  let amount0: bigint;
  let amount1: bigint;
  let version: 'v2' | 'v3';
  if (topic0 === DEX_TOPICS.v2Swap) {
    if (words.some((w) => w === null)) return null;
    const [in0, in1, out0, out1] = (words as string[]).map(wordUint);
    amount0 = in0 - out0;
    amount1 = in1 - out1;
    version = 'v2';
  } else if (topic0 === DEX_TOPICS.v3Swap) {
    if (!words[0] || !words[1]) return null;
    amount0 = wordInt(words[0]);
    amount1 = wordInt(words[1]);
    version = 'v3';
  } else {
    return null;
  }
  return {
    tx_hash: b.txHash,
    log_index: logIndex,
    pool: b.address,
    version,
    block_time: b.time.toISOString(),
    block_number: b.block,
    sender,
    recipient,
    amount0: amount0.toString(),
    amount1: amount1.toString(),
  };
}

/**
 * Picks one signature among the candidates a public signature database
 * returns for a selector: the first one backed by a verified contract, else
 * the first unfiltered one. Returns null when there is none.
 */
/**
 * A Solidity function signature and nothing else: identifier, then a list of
 * ABI types. Anyone can register text in the public databases; this keeps
 * free text (URLs, spaces, markup) out of the labels we store and serve.
 */
const SIGNATURE_RE = /^[A-Za-z_$][A-Za-z0-9_$]*\([A-Za-z0-9_,[\]()]*\)$/;
const MAX_SIGNATURE_LENGTH = 256;

export function pickSignature(
  candidates: Array<{ name?: unknown; filtered?: unknown; hasVerifiedContract?: unknown }> | null | undefined
): string | null {
  const list = (candidates ?? []).filter(
    (c): c is { name: string; filtered?: unknown; hasVerifiedContract?: unknown } =>
      typeof c?.name === 'string' && c.name.length > 0 && c.name.length <= MAX_SIGNATURE_LENGTH && SIGNATURE_RE.test(c.name)
  );
  const verified = list.find((c) => c.hasVerifiedContract === true && c.filtered !== true);
  if (verified) return verified.name;
  const unfiltered = list.find((c) => c.filtered !== true);
  return unfiltered?.name ?? null;
}

/** "transfer(address,uint256)" -> "transfer". */
export function methodName(signature: string | null): string | null {
  if (!signature) return null;
  const i = signature.indexOf('(');
  return i > 0 ? signature.slice(0, i) : signature;
}
