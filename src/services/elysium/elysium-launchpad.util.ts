/**
 * Pure decoders for the Elysium launchpads (Chainzy, CorePad, Signal), read
 * from /logs by topic0. No I/O so they stay unit-testable.
 *
 * Event layouts were matched against real logs and cross-checked with the
 * elysiumeco.xyz token market (price, volume, trade count, bonding progress).
 * Anyone can emit any topic on a testnet, so launch events are only accepted
 * from the launchpads' own contracts, and trades only for known markets.
 */
import { parseUpstreamTime } from './elysium-ingest.util';
import { dataWord, topicAddress, wordInt, wordUint } from './elysium-dex.util';

export const LAUNCHPAD_TOPICS = {
  /** Chainzy HyperEVMLaunchCreated: topic2 token, topic3 V3 pool, data w1 creator. */
  chainzyLaunch: '0x51cbea940270ec71f9e25bc787e65264264ec325f179154420b26a013c42c2df',
  /** CorePad LaunchCreated(id, token, curve | creator, name, symbol). */
  corepadLaunch: '0x857f6038583a34516f405db6cc1a1112e32e20ddd3d9a5297662fbc7f730d3fc',
  /** CorePad curve trade: topic2 trader | isBuy, hypeGross, tokens, fee, vHype, vToken. */
  corepadTrade: '0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3',
  /** CorePad curve graduation. */
  corepadGraduated: '0x7b0c29e799ed468266b4d070c03070137a95cb869c5eb7c18063fb7b1a7a09c5',
  /** Signal CurveLaunch(token, curve, processor | pair, quote). */
  signalCurveLaunch: '0x950d597907e10eb9e6a9e67d463e59338fec1cc0d66df1565a75981aec17e108',
  /** Signal router trade: topic1 curve, topic2 sender | isBuy, amountIn, amountOut, venue (0 curve, 1 pair). */
  signalRouterTrade: '0x17170a39726ef768d1f687af8c8f287fa6c8d8e70964485da189c95a01a28341',
  /** Signal Graduated(pair indexed | tokens, quote, liquidity), emitted by the curve. */
  signalGraduated: '0xcb64f2436060c9575db20c5dcf9cdc11657017ee5b0301949f531b3dd7da6b19',
  /** Signal V4 launch: topic1 poolId, topic2 token, topic3 creator | quote, ... */
  signalV4Launch: '0x2f2be0acb0654df0ab17fd0891f6769f8d1caa7e4b84a114befea912a3e86d37',
  /** Uniswap V2 Swap (Signal pairs after graduation). */
  v2Swap: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  /** Uniswap V3 Swap (Chainzy pools). */
  v3Swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  /** Uniswap V4 Swap (Signal V4 pools), emitted by the PoolManager. */
  v4Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
} as const;

/** Contracts allowed to emit each launch event (every emitter seen since genesis). */
const EMITTERS = {
  chainzy: new Set([
    '0x4da0a4e783bcbd478ef8f7fbb20583ccbf918888',
    '0x900d467c40d8fb600a0ad7be4ae7bcbc34b98888',
    '0xa391a222d55a3eae757788d1a6ee1e3415c18888',
    '0x071bad7e1e12a0cfdabe6d365b5dd6771d148888',
    '0xa7630c8358fcb1e77d8883de55bc5f3d61f58888',
  ]),
  corepad: new Set(['0x8547e759715b1bbd67291e06395e0c5ffea4de13']),
  signalCurve: new Set(['0xe7d6263e09a4691d58dca528043efdfeec4db2c0', '0x06c87c903241a7bbf82676a3df97e2bd61228a38']),
  signalV4: new Set(['0x89593cf10d68a0d7d0c2bba3ced12f55fad0adeb']),
  signalRouter: new Set(['0x75d98c98f92d1f5d65ca6a962f36476be34c64ae', '0xbdfc5a7b1dc9b821f26c525c815338f4eec4cf8c']),
  v4PoolManager: new Set(['0x889a96eedb1df35a012d7e48baf7f9c780f1243b']),
} as const;

/** Uniswap V4 PoolManager(s): they hold V4 pool liquidity. */
export const V4_POOL_MANAGERS = [...EMITTERS.v4PoolManager];

/** Wrapped HYPE used as the quote by Chainzy pools. */
export const CHAINZY_WHYPE = '0xd20b24f05930f114100d108a481c4ec022f40daa';
/** CorePad curves are paid in native HYPE. */
export const NATIVE_HYPE = '0x0000000000000000000000000000000000000000';
/** Wrapped HYPE used as the quote by Signal (curves, pairs, V4 pools). */
export const SIGNAL_WHYPE = '0xcd57f65c2b0e5881cfc2e609f7cd53b746e1f234';
/** Quotes valued at the HYPE price; a launch on any other quote gets no USD value. */
export const HYPE_QUOTES = [NATIVE_HYPE, CHAINZY_WHYPE, SIGNAL_WHYPE];

/** Every launchpad token has 1B supply and 18 decimals. */
export const LAUNCH_TOTAL_SUPPLY = 1e9;
/** Tokens a curve sells before it graduates (raw, 18 decimals). */
export const CURVE_SALE_SUPPLY: Record<'CorePad' | 'Signal', bigint> = {
  CorePad: 800_000_000n * 10n ** 18n,
  Signal: 750_000_000n * 10n ** 18n,
};

/** Wallets that hold supply on the creator's behalf: kept out of the top-10 share. */
export const CHAINZY_CREATOR_LOCKER = '0x9c820a975526915c579a3c582a0c8bad32148888';

export type Launchpad = 'Chainzy' | 'CorePad' | 'Signal';
export type LaunchKind = 'curve' | 'v3' | 'v4';
export type TradeVenue = 'curve' | 'v2' | 'v3' | 'v4';

export interface LaunchRow {
  token: string;
  launchpad: Launchpad;
  kind: LaunchKind;
  /** Null when the event does not carry it (Signal curves: read from the tx sender). */
  creator: string | null;
  created_at: string;
  block_number: string;
  tx_hash: string;
  /** Bonding curve contract (curve launches). */
  curve: string | null;
  /** Where the token trades: V3 pool, V2 pair (after graduation) or V4 poolId. */
  pool: string | null;
  quote: string;
  name: string | null;
  symbol: string | null;
}

export interface LaunchTradeRow {
  tx_hash: string;
  log_index: number;
  token: string;
  venue: TradeVenue;
  block_time: string;
  block_number: string;
  trader: string | null;
  is_buy: boolean;
  /** Raw amounts (18 decimals) as decimal strings. */
  quote_amount: string;
  token_amount: string;
  /** Quote per token after the trade. */
  price: number;
}

export interface GraduationRow {
  curve: string;
  graduated_at: string;
}

/** A token's market as the trade decoders need it. */
export interface LaunchMarket {
  token: string;
  launchpad: Launchpad;
  quote: string;
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

interface Base {
  l: RawLog;
  topic0: string;
  data: string;
  time: Date;
  block: string;
  txHash: string;
  address: string;
  logIndex: number;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const Q96 = 2 ** 96;
const WEI = 1e18;

function lower(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null;
}

function base(raw: unknown): Base | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as RawLog;
  const topic0 = lower(l.topic0);
  const data = lower(l.data) ?? '0x';
  const time = parseUpstreamTime(l.block_time);
  const txHash = lower(l.tx_hash);
  const address = lower(l.address);
  const logIndex = Number(l.log_index);
  const block =
    typeof l.block_number === 'number' && Number.isFinite(l.block_number)
      ? String(Math.trunc(l.block_number))
      : typeof l.block_number === 'string' && /^\d+$/.test(l.block_number)
        ? l.block_number
        : null;
  if (!topic0 || !time || !txHash || !address || block === null || !Number.isInteger(logIndex) || !data.startsWith('0x')) {
    return null;
  }
  return { l, topic0, data, time, block, txHash, address, logIndex };
}

function word(data: string, i: number): string | null {
  return dataWord(data, i);
}

function wordAddr(data: string, i: number): string | null {
  const w = word(data, i);
  return w ? `0x${w.slice(-40)}` : null;
}

/** ABI-encoded dynamic string whose offset sits in word `i`; null if malformed. */
function wordString(data: string, i: number): string | null {
  const off = word(data, i);
  if (!off) return null;
  const at = Number(wordUint(off)) / 32;
  const lenWord = Number.isInteger(at) ? word(data, at) : null;
  if (!lenWord) return null;
  const len = Number(wordUint(lenWord));
  const start = 2 + (at + 1) * 64;
  const hex = data.slice(start, start + len * 2);
  if (len > 256 || hex.length !== len * 2) return null;
  const text = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim();
  return text === '' ? null : text;
}

/** Raw 18-decimal amount to a float (for prices only, never stored as amounts). */
function toUnits(v: bigint): number {
  return Number(v) / WEI;
}

/** Quote per token from a sqrtPriceX96, both sides 18 decimals. */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): number {
  const r = Number(sqrtPriceX96) / Q96;
  const p = r * r; // currency1 per currency0
  if (!Number.isFinite(p) || p <= 0) return 0;
  return tokenIsCurrency0 ? p : 1 / p;
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Launch event -> LaunchRow, or null when it is not one of ours. */
export function decodeLaunch(raw: unknown): LaunchRow | null {
  const b = base(raw);
  if (!b) return null;
  const common = { created_at: b.time.toISOString(), block_number: b.block, tx_hash: b.txHash };

  if (b.topic0 === LAUNCHPAD_TOPICS.chainzyLaunch && EMITTERS.chainzy.has(b.address)) {
    const token = topicAddress(b.l.topic2);
    const pool = topicAddress(b.l.topic3);
    if (!token || !pool) return null;
    return {
      ...common,
      token,
      launchpad: 'Chainzy',
      kind: 'v3',
      creator: wordAddr(b.data, 1),
      curve: null,
      pool,
      quote: CHAINZY_WHYPE,
      name: null,
      symbol: null,
    };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.corepadLaunch && EMITTERS.corepad.has(b.address)) {
    const token = topicAddress(b.l.topic2);
    const curve = topicAddress(b.l.topic3);
    if (!token || !curve) return null;
    return {
      ...common,
      token,
      launchpad: 'CorePad',
      kind: 'curve',
      creator: wordAddr(b.data, 0),
      curve,
      pool: null,
      quote: NATIVE_HYPE,
      name: wordString(b.data, 1),
      symbol: wordString(b.data, 2),
    };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.signalCurveLaunch && EMITTERS.signalCurve.has(b.address)) {
    const token = topicAddress(b.l.topic1);
    const curve = topicAddress(b.l.topic2);
    const pair = wordAddr(b.data, 0);
    const quote = wordAddr(b.data, 1);
    if (!token || !curve || !quote) return null;
    return { ...common, token, launchpad: 'Signal', kind: 'curve', creator: null, curve, pool: pair, quote, name: null, symbol: null };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.signalV4Launch && EMITTERS.signalV4.has(b.address)) {
    const poolId = lower(b.l.topic1);
    const token = topicAddress(b.l.topic2);
    const creator = topicAddress(b.l.topic3);
    const quote = wordAddr(b.data, 0);
    if (!poolId || !HEX32.test(poolId) || !token || !quote) return null;
    return { ...common, token, launchpad: 'Signal', kind: 'v4', creator, curve: null, pool: poolId, quote, name: null, symbol: null };
  }
  return null;
}

/** Graduation event emitted by a curve -> GraduationRow (the caller checks the curve is known). */
export function decodeGraduation(raw: unknown): GraduationRow | null {
  const b = base(raw);
  if (!b) return null;
  if (b.topic0 !== LAUNCHPAD_TOPICS.corepadGraduated && b.topic0 !== LAUNCHPAD_TOPICS.signalGraduated) return null;
  return { curve: b.address, graduated_at: b.time.toISOString() };
}

/**
 * Trade log -> LaunchTradeRow. `markets` maps a market key to its token:
 * curve address (CorePad, Signal curves), V2 pair (Signal after graduation),
 * V3 pool address (Chainzy) or V4 poolId (Signal V4). Logs for unknown markets are dropped.
 */
export function decodeLaunchTrade(raw: unknown, markets: Map<string, LaunchMarket>): LaunchTradeRow | null {
  const b = base(raw);
  if (!b) return null;
  const common = { tx_hash: b.txHash, log_index: b.logIndex, block_time: b.time.toISOString(), block_number: b.block };

  if (b.topic0 === LAUNCHPAD_TOPICS.corepadTrade) {
    const m = markets.get(b.address);
    const w = [0, 1, 2, 4, 5].map((i) => word(b.data, i));
    if (!m || m.launchpad !== 'CorePad' || w.some((x) => x === null)) return null;
    const [isBuy, hype, tokens, vHype, vToken] = w.map((x) => wordUint(x as string));
    if (tokens === 0n || vToken === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'curve',
      trader: topicAddress(b.l.topic2),
      is_buy: isBuy === 1n,
      quote_amount: hype.toString(),
      token_amount: tokens.toString(),
      price: toUnits(vHype) / toUnits(vToken),
    };
  }

  if (b.topic0 === LAUNCHPAD_TOPICS.signalRouterTrade && EMITTERS.signalRouter.has(b.address)) {
    const curve = topicAddress(b.l.topic1);
    const m = curve ? markets.get(curve) : undefined;
    const w = [0, 1, 2, 3].map((i) => word(b.data, i));
    if (!m || m.launchpad !== 'Signal' || w.some((x) => x === null)) return null;
    const [isBuyW, amountIn, amountOut, venue] = w.map((x) => wordUint(x as string));
    // Pair trades (venue 1) are read from the pair's own Swap logs, which also catch other routers.
    if (venue !== 0n) return null;
    const isBuy = isBuyW === 1n;
    const quote = isBuy ? amountIn : amountOut;
    const tokens = isBuy ? amountOut : amountIn;
    if (tokens === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'curve',
      trader: topicAddress(b.l.topic2),
      is_buy: isBuy,
      quote_amount: quote.toString(),
      token_amount: tokens.toString(),
      price: toUnits(quote) / toUnits(tokens),
    };
  }

  if (b.topic0 === LAUNCHPAD_TOPICS.v2Swap) {
    // Swap(sender indexed, to indexed | amount0In, amount1In, amount0Out, amount1Out).
    const m = markets.get(b.address);
    const w = [0, 1, 2, 3].map((i) => word(b.data, i));
    if (!m || w.some((x) => x === null)) return null;
    const [a0In, a1In, a0Out, a1Out] = w.map((x) => wordUint(x as string));
    const tokenIs0 = m.token < m.quote;
    const tokenIn = tokenIs0 ? a0In : a1In;
    const tokenOut = tokenIs0 ? a0Out : a1Out;
    const quote = tokenIs0 ? a1In + a1Out : a0In + a0Out;
    const tokens = tokenIn + tokenOut;
    if (tokens === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'v2',
      trader: topicAddress(b.l.topic2),
      is_buy: tokenOut > 0n,
      quote_amount: quote.toString(),
      token_amount: tokens.toString(),
      price: toUnits(quote) / toUnits(tokens),
    };
  }

  if (b.topic0 === LAUNCHPAD_TOPICS.v3Swap) {
    // Swap(sender indexed, recipient indexed | amount0, amount1, sqrtPriceX96, liquidity, tick); positive = into the pool.
    const m = markets.get(b.address);
    const w = [0, 1, 2].map((i) => word(b.data, i));
    if (!m || w.some((x) => x === null)) return null;
    const amount0 = wordInt(w[0] as string);
    const amount1 = wordInt(w[1] as string);
    const tokenIs0 = m.token < m.quote;
    const tokenAmt = tokenIs0 ? amount0 : amount1;
    const quoteAmt = tokenIs0 ? amount1 : amount0;
    if (tokenAmt === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'v3',
      trader: topicAddress(b.l.topic2),
      is_buy: tokenAmt < 0n,
      quote_amount: abs(quoteAmt).toString(),
      token_amount: abs(tokenAmt).toString(),
      price: priceFromSqrt(wordUint(w[2] as string), tokenIs0),
    };
  }

  if (b.topic0 === LAUNCHPAD_TOPICS.v4Swap && EMITTERS.v4PoolManager.has(b.address)) {
    // Swap(id indexed, sender indexed | amount0 int128, amount1 int128, sqrtPriceX96, ...); positive = paid to the swapper.
    const poolId = lower(b.l.topic1);
    const m = poolId ? markets.get(poolId) : undefined;
    const w = [0, 1, 2].map((i) => word(b.data, i));
    if (!m || w.some((x) => x === null)) return null;
    const amount0 = wordInt(w[0] as string);
    const amount1 = wordInt(w[1] as string);
    const tokenIs0 = m.token < m.quote;
    const tokenAmt = tokenIs0 ? amount0 : amount1;
    const quoteAmt = tokenIs0 ? amount1 : amount0;
    if (tokenAmt === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'v4',
      // The PoolManager only sees the router: the trader is read from the tx sender at query time.
      trader: null,
      is_buy: tokenAmt > 0n,
      quote_amount: abs(quoteAmt).toString(),
      token_amount: abs(tokenAmt).toString(),
      price: priceFromSqrt(wordUint(w[2] as string), tokenIs0),
    };
  }

  return null;
}

/** Market keys a launch is traded under. */
export function launchMarketKeys(l: Pick<LaunchRow, 'curve' | 'pool'>): string[] {
  // A curve launch trades on its curve, then on its V2 pair once graduated.
  return [l.curve, l.pool].filter((k): k is string => k !== null);
}

/** Topic order for one ingest window: launches first, so trades in the same window find their market. */
export const LAUNCH_TOPIC_ORDER = [
  LAUNCHPAD_TOPICS.chainzyLaunch,
  LAUNCHPAD_TOPICS.corepadLaunch,
  LAUNCHPAD_TOPICS.signalCurveLaunch,
  LAUNCHPAD_TOPICS.signalV4Launch,
] as const;
export const GRADUATION_TOPICS = [LAUNCHPAD_TOPICS.corepadGraduated, LAUNCHPAD_TOPICS.signalGraduated] as const;
export const TRADE_TOPICS = [
  LAUNCHPAD_TOPICS.corepadTrade,
  LAUNCHPAD_TOPICS.signalRouterTrade,
  LAUNCHPAD_TOPICS.v2Swap,
  LAUNCHPAD_TOPICS.v3Swap,
  LAUNCHPAD_TOPICS.v4Swap,
] as const;
