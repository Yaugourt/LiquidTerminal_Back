/**
 * Pure decoders for the Elysium launchpads (Chainzy, CorePad, Signal, Neuriio, aka.fun,
 * BunnyPad, Kiln), read
 * from /logs by topic0. No I/O so they stay unit-testable.
 *
 * Event layouts were matched against real logs and cross-checked with the
 * elysiumeco.xyz token market (price, volume, trade count, bonding progress).
 * Anyone can emit any topic on a testnet, so launch events are only accepted
 * from the launchpads' own contracts, and trades only for known markets.
 */
import { address, boundedText, int8String, parseUpstreamTime, txHash } from './elysium-ingest.util';
import { dataWord, logIndexOf, topicAddress, wordInt, wordUint } from './elysium-dex.util';

export const LAUNCHPAD_TOPICS = {
  /** Chainzy HyperEVMLaunchCreated: topic2 token, topic3 V3 pool, data w1 creator. */
  chainzyLaunch: '0x51cbea940270ec71f9e25bc787e65264264ec325f179154420b26a013c42c2df',
  /** CorePad LaunchCreated(id, token, curve | creator, name, symbol). */
  corepadLaunch: '0x857f6038583a34516f405db6cc1a1112e32e20ddd3d9a5297662fbc7f730d3fc',
  /**
   * CorePad curve trade: topic2 trader | isBuy, hypeGross, tokens, fee, vHype, vToken.
   * Neuriio pads emit the same event (Trade(token, trader, ...)) with the token in topic1.
   */
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
  /** Neuriio Launched(token, creator, xUserId | handle, category, profileHash, virtualQuote). */
  neuriioLaunch: '0x096478a529366552bb1b4db7668203cf0d554c786f86c20059967309f535ab06',
  /** Neuriio FtfLaunched(token, founder | name, ticker, memberXIds[4], members[4], profileHash, virtualQuote). */
  neuriioFtfLaunch: '0xc654e8d698fc1aaf01d3e71758d7ce066f2303167c977fc9b8626ee1422b8745',
  /** Neuriio Graduated(token, pair | quote, tokens, liquidityBurned), emitted by the pad. */
  neuriioGraduated: '0x487dc7f66c623fb0ff13f9024a3ff9675453d069e075eceb12d9f8d7870e2374',
  /**
   * aka.fun: its V4 hook registers each launch with (token, poolId) as topics. Used as the launch
   * event because the factory's own event does not carry the poolId; the creator comes from the
   * tx sender and the symbol from the token table.
   */
  akaPoolRegistered: '0x72db6526c14c88d08586af95f46d477c4a8a8809e3d6fa31eac4f7bffb8f3597',
  /** BunnyPad launch: topic1 token, topic2 creator | name, symbol, ..., w6 virtual HYPE reserve. */
  bunnyLaunch: '0x00aa4e081030a9d4e5022596b3e7554c97456e4d5a055b8ea86d09950d365467',
  /** Kiln TokenLaunched(token, curve, creator | name, symbol, uri, graduationTarget). */
  kilnLaunch: '0x63398f645c29c31459939d96b0065e3ae45b5bf5be0a42a4b304fe822a0c500e',
  /** Kiln CurveBuy(buyer, recipient | hypeIn, tokensOut, fee, fee), emitted by the token's curve. */
  kilnBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  /** Kiln CurveSell(seller, recipient | tokensIn, hypeOut, fee, fee), emitted by the token's curve. */
  kilnSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  /** Kiln LaunchGraduated(token | hype, tokens), emitted by the factory. */
  kilnGraduated: '0x0695bc30069617ee2f9f54b5477dfe10d9771150bdbffbae196d7d8a0b18b97f',
  /** Uniswap V2 Swap (Signal and Neuriio pairs after graduation). */
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
  /** Signal's PoolManager, and aka.fun's own deployment. */
  v4PoolManager: new Set(['0x889a96eedb1df35a012d7e48baf7f9c780f1243b', '0x0088bea218c283a939c93d7db8353cd87cdcf647']),
  /** The V4 hook every aka.fun pool uses (native HYPE / token, fee 0, tick spacing 1). */
  akaHook: new Set(['0xd492b95e2ecf74db6c5493e7c32f6816248484cc']),
  /** BunnyPad: one contract holds every token and its HYPE, no pool and no graduation. */
  bunnyPad: new Set(['0x3c4f47959101557eed9bc4ae8d8d986ae8d3e5b1']),
  kilnFactory: new Set(['0x18defd8b02b9cea88a5d5c031ee29573aa78c63a']),
} as const;

/** Wrapped HYPE of Neuriio's own Uniswap V2 fork (pairs of the HYPE-priced pads). */
export const NEURIIO_WHYPE = '0x517f12d5d17c4755fbdf988fe9cc24334c3314c7';
/** Test USDC (6 decimals) the current Neuriio pad is priced in. */
export const NEURIIO_USDC = '0xe83c3630cab1c3d1d3b19a1f6ee393618c690c7b';

/**
 * Every NeuriioPad version (all deployed by Neuriio's deployer 0xef58...17a8) and the quote its
 * tokens trade against. Older pads sell for native HYPE and graduate into TOKEN/WHYPE pairs, so
 * their launches are stored with the WHYPE quote; the current pad sells for test USDC.
 */
const NEURIIO_PADS: ReadonlyMap<string, string> = new Map([
  ['0x3a4b7a2604918ce8a4a055d353056f988355b98a', NEURIIO_WHYPE],
  ['0xfd4b6e796456e2f76ddcccf46b9dea4c677cb5e1', NEURIIO_WHYPE],
  ['0x1cc0838a1344577f5fb4547be8dd72456c3bc97e', NEURIIO_WHYPE],
  ['0x6ef011b34d8c08e20a35f4d25cdcc84070e4cb53', NEURIIO_WHYPE],
  ['0x3c1b64c5d4ecc1ffc7fa8ab2eb643e86aba8932f', NEURIIO_WHYPE],
  ['0x440c1bd5395a7cbef870c91f600e39aa48433c73', NEURIIO_WHYPE],
  ['0xc54c48e6ef90b53ef49e7bccdac2d5d0578e43a7', NEURIIO_WHYPE],
  ['0x0ab518a961c77911ba9b2635cfe56b9ea54ec73e', NEURIIO_WHYPE],
  ['0xd9943d81b72aa55e52580bbb595af797b04d5e59', NEURIIO_WHYPE],
  ['0x892b08a9b3987516a4ae5ab7d7e4d56642268d76', NEURIIO_USDC],
]);

/** Uniswap V4 PoolManager(s): they hold V4 pool liquidity. */
export const V4_POOL_MANAGERS = [...EMITTERS.v4PoolManager];

/** Wrapped HYPE used as the quote by Chainzy pools. */
export const CHAINZY_WHYPE = '0xd20b24f05930f114100d108a481c4ec022f40daa';
/** CorePad curves are paid in native HYPE. */
export const NATIVE_HYPE = '0x0000000000000000000000000000000000000000';
/** Wrapped HYPE used as the quote by Signal (curves, pairs, V4 pools). */
export const SIGNAL_WHYPE = '0xcd57f65c2b0e5881cfc2e609f7cd53b746e1f234';
/** Quotes valued at the HYPE price; a launch on any other quote gets no USD value. */
export const HYPE_QUOTES = [NATIVE_HYPE, CHAINZY_WHYPE, SIGNAL_WHYPE, NEURIIO_WHYPE];
/** Quotes valued at $1 (test stablecoins). */
export const USD_QUOTES = [NEURIIO_USDC];

/** Decimals of a quote token: every HYPE quote has 18, the test USDC 6. */
export function quoteDecimals(quote: string): number {
  return USD_QUOTES.includes(quote) ? 6 : 18;
}

/**
 * BunnyPad prices on a constant product over a virtual HYPE reserve plus the real one: 37.4844
 * HYPE on every launch since the first (launch w6, read 2026-11-02). Checked: x*y holds across
 * trades within fees, and the first dev buy gives exactly 1e9 * 0.0294 / (37.4844 + 0.0294).
 */
export const BUNNY_VIRTUAL_HYPE = 37_484_400_000_000_000_000n;

/** Every launchpad token has 1B supply and 18 decimals. */
export const LAUNCH_TOTAL_SUPPLY = 1e9;
/** Tokens a curve sells before it graduates (raw, 18 decimals). */
export const CURVE_SALE_SUPPLY: Partial<Record<Launchpad, bigint>> = {
  CorePad: 800_000_000n * 10n ** 18n,
  Signal: 750_000_000n * 10n ** 18n,
  Neuriio: 793_100_000n * 10n ** 18n,
};

/** Wallets that hold supply on the creator's behalf: kept out of the top-10 share. */
export const CHAINZY_CREATOR_LOCKER = '0x9c820a975526915c579a3c582a0c8bad32148888';

export type Launchpad = 'Chainzy' | 'CorePad' | 'Signal' | 'Neuriio' | 'aka.fun' | 'BunnyPad' | 'Kiln';
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

/** A graduation, keyed by its curve contract (CorePad, Signal) or its token (Neuriio pads, Kiln). */
export interface GraduationRow {
  curve: string | null;
  token: string | null;
  /** The pad that emitted it, for the graduations keyed by token (the pad's own contract says so). */
  launchpad: Launchpad | null;
  /** Pair the token moved to, when the event names it. */
  pool: string | null;
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
  // Checked for their exact shape: these go to fixed-width columns (see elysium-ingest.util).
  const hash = txHash(l.tx_hash);
  const emitter = address(l.address);
  const logIndex = logIndexOf(l.log_index);
  const block = int8String(l.block_number);
  if (!topic0 || !time || !hash || !emitter || block === null || logIndex === null || !data.startsWith('0x')) {
    return null;
  }
  return { l, topic0, data, time, block, txHash: hash, address: emitter, logIndex };
}

function word(data: string, i: number): string | null {
  return dataWord(data, i);
}

function wordAddr(data: string, i: number): string | null {
  const w = word(data, i);
  return w ? `0x${w.slice(-40)}` : null;
}

/** Columns of elysium_launch a launch event fills with text its creator chose. */
const NAME_MAX = 256;
const SYMBOL_MAX = 128;

/**
 * ABI-encoded dynamic string whose offset sits in word `i`, cleaned and cut to `max` characters
 * (the launch's creator writes it: a symbol longer than its column failed the whole page of
 * launches, on every run); null if malformed or empty.
 */
function wordString(data: string, i: number, max = NAME_MAX): string | null {
  const off = word(data, i);
  if (!off) return null;
  const at = Number(wordUint(off)) / 32;
  const lenWord = Number.isInteger(at) ? word(data, at) : null;
  if (!lenWord) return null;
  const len = Number(wordUint(lenWord));
  const start = 2 + (at + 1) * 64;
  const hex = data.slice(start, start + len * 2);
  if (len > 256 || hex.length !== len * 2) return null;
  return boundedText(Buffer.from(hex, 'hex').toString('utf8'), max);
}

/** Raw amount to a float (for prices only, never stored as amounts). */
function toUnits(v: bigint, decimals = 18): number {
  return decimals === 18 ? Number(v) / WEI : Number(v) / 10 ** decimals;
}

/**
 * Quote per token from a sqrtPriceX96; 0 when the value gives no price. The token has 18
 * decimals like every launchpad token, the quote `quoteDec` (the ratio is between raw amounts:
 * it was read as if every quote had 18, which a 6-decimal quote would have priced 10^12 off).
 */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, quoteDec = 18): number {
  const r = Number(sqrtPriceX96) / Q96;
  const p = r * r; // currency1 per currency0, raw
  if (!Number.isFinite(p) || p <= 0) return 0;
  const price = (tokenIsCurrency0 ? p : 1 / p) * 10 ** (18 - quoteDec);
  return Number.isFinite(price) ? price : 0;
}

/**
 * The price a pool trade is stored with: the pool's price after the swap, or, when the event
 * carries a value that gives none, what the trade itself paid per token. A trade stored at 0
 * used to become the launch's last price.
 */
function poolPrice(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, quote: string, quoteAmt: bigint, tokenAmt: bigint): number {
  const dec = quoteDecimals(quote);
  const spot = priceFromSqrt(sqrtPriceX96, tokenIsCurrency0, dec);
  if (spot > 0) return spot;
  const paid = toUnits(abs(quoteAmt), dec) / toUnits(abs(tokenAmt));
  return Number.isFinite(paid) && paid > 0 ? paid : 0;
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
      symbol: wordString(b.data, 2, SYMBOL_MAX),
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
  const neuriioQuote = NEURIIO_PADS.get(b.address);
  if (neuriioQuote && (b.topic0 === LAUNCHPAD_TOPICS.neuriioLaunch || b.topic0 === LAUNCHPAD_TOPICS.neuriioFtfLaunch)) {
    const token = topicAddress(b.l.topic1);
    if (!token) return null;
    // A solo launch is named after the creator's X handle (name @handle, ticker HANDLE); an FTF carries both.
    const solo = b.topic0 === LAUNCHPAD_TOPICS.neuriioLaunch;
    const handle = solo ? wordString(b.data, 0) : null;
    return {
      ...common,
      token,
      launchpad: 'Neuriio',
      kind: 'curve',
      creator: topicAddress(b.l.topic2),
      // The curve lives inside the pad: Neuriio markets are keyed by the token (see launchMarketKeys).
      curve: null,
      pool: null,
      quote: neuriioQuote,
      name: solo ? (handle ? boundedText(`@${handle}`, NAME_MAX) : null) : wordString(b.data, 0),
      symbol: solo ? (handle ? boundedText(handle.toUpperCase(), SYMBOL_MAX) : null) : wordString(b.data, 1, SYMBOL_MAX),
    };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.signalV4Launch && EMITTERS.signalV4.has(b.address)) {
    const poolId = lower(b.l.topic1);
    const token = topicAddress(b.l.topic2);
    const creator = topicAddress(b.l.topic3);
    const quote = wordAddr(b.data, 0);
    if (!poolId || !HEX32.test(poolId) || !token || !quote) return null;
    return { ...common, token, launchpad: 'Signal', kind: 'v4', creator, curve: null, pool: poolId, quote, name: null, symbol: null };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.akaPoolRegistered && EMITTERS.akaHook.has(b.address)) {
    const token = topicAddress(b.l.topic1);
    const poolId = lower(b.l.topic2);
    if (!token || !poolId || !HEX32.test(poolId)) return null;
    // Every aka.fun pool pairs the token with native HYPE: no curve, no graduation.
    return { ...common, token, launchpad: 'aka.fun', kind: 'v4', creator: null, curve: null, pool: poolId, quote: NATIVE_HYPE, name: null, symbol: null };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.bunnyLaunch && EMITTERS.bunnyPad.has(b.address)) {
    const token = topicAddress(b.l.topic1);
    if (!token) return null;
    return {
      ...common,
      token,
      launchpad: 'BunnyPad',
      kind: 'curve',
      creator: topicAddress(b.l.topic2),
      // The market lives inside the pad: BunnyPad markets are keyed by the token (see launchMarketKeys).
      curve: null,
      pool: null,
      quote: NATIVE_HYPE,
      name: wordString(b.data, 0),
      symbol: wordString(b.data, 1, SYMBOL_MAX),
    };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.kilnLaunch && EMITTERS.kilnFactory.has(b.address)) {
    const token = topicAddress(b.l.topic1);
    const curve = topicAddress(b.l.topic2);
    if (!token || !curve) return null;
    return {
      ...common,
      token,
      launchpad: 'Kiln',
      kind: 'curve',
      creator: topicAddress(b.l.topic3),
      curve,
      pool: null,
      quote: NATIVE_HYPE,
      name: wordString(b.data, 0),
      symbol: wordString(b.data, 1, SYMBOL_MAX),
    };
  }
  return null;
}

/** Graduation event -> GraduationRow (the caller checks the curve or token is known). */
export function decodeGraduation(raw: unknown): GraduationRow | null {
  const b = base(raw);
  if (!b) return null;
  const graduated_at = b.time.toISOString();
  if (b.topic0 === LAUNCHPAD_TOPICS.kilnGraduated) {
    // Graduation locks the liquidity: Kiln tokens do not trade on a pool afterwards.
    const token = topicAddress(b.l.topic1);
    if (!EMITTERS.kilnFactory.has(b.address) || !token) return null;
    return { curve: null, token, launchpad: 'Kiln', pool: null, graduated_at };
  }
  if (b.topic0 === LAUNCHPAD_TOPICS.neuriioGraduated) {
    const token = topicAddress(b.l.topic1);
    if (!NEURIIO_PADS.has(b.address) || !token) return null;
    return { curve: null, token, launchpad: 'Neuriio', pool: topicAddress(b.l.topic2), graduated_at };
  }
  if (b.topic0 !== LAUNCHPAD_TOPICS.corepadGraduated && b.topic0 !== LAUNCHPAD_TOPICS.signalGraduated) return null;
  return { curve: b.address, token: null, launchpad: null, pool: null, graduated_at };
}

/**
 * Trade log -> LaunchTradeRow. `markets` maps a market key to its token:
 * curve address (CorePad, Signal curves), token (Neuriio), V2 pair (Signal and Neuriio after graduation),
 * V3 pool address (Chainzy) or V4 poolId (Signal V4). Logs for unknown markets are dropped.
 */
export function decodeLaunchTrade(raw: unknown, markets: Map<string, LaunchMarket>): LaunchTradeRow | null {
  const b = base(raw);
  if (!b) return null;
  const common = { tx_hash: b.txHash, log_index: b.logIndex, block_time: b.time.toISOString(), block_number: b.block };

  if (b.topic0 === LAUNCHPAD_TOPICS.corepadTrade && EMITTERS.bunnyPad.has(b.address)) {
    // CorePad's Trade topic with the token in topic1; w4/w5 are the REAL reserves after the trade.
    const token = topicAddress(b.l.topic1);
    const m = token ? markets.get(token) : undefined;
    const w = [0, 1, 2, 4, 5].map((i) => word(b.data, i));
    if (!m || m.launchpad !== 'BunnyPad' || w.some((x) => x === null)) return null;
    const [isBuy, hype, tokens, hypeReserve, tokenReserve] = w.map((x) => wordUint(x as string));
    if (tokens === 0n || tokenReserve === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'curve',
      // The pad's own buyback-and-burn shows up with the pad as trader.
      trader: topicAddress(b.l.topic2),
      is_buy: isBuy === 1n,
      quote_amount: hype.toString(),
      token_amount: tokens.toString(),
      price: toUnits(BUNNY_VIRTUAL_HYPE + hypeReserve) / toUnits(tokenReserve),
    };
  }

  if (b.topic0 === LAUNCHPAD_TOPICS.kilnBuy || b.topic0 === LAUNCHPAD_TOPICS.kilnSell) {
    // Emitted by the token's curve. No reserves in the event: the price is the trade's average.
    const m = markets.get(b.address);
    const w = [0, 1].map((i) => word(b.data, i));
    if (!m || m.launchpad !== 'Kiln' || w.some((x) => x === null)) return null;
    const isBuy = b.topic0 === LAUNCHPAD_TOPICS.kilnBuy;
    const [a, c] = w.map((x) => wordUint(x as string));
    const hype = isBuy ? a : c;
    const tokens = isBuy ? c : a;
    if (tokens === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'curve',
      trader: topicAddress(b.l.topic1),
      is_buy: isBuy,
      quote_amount: hype.toString(),
      token_amount: tokens.toString(),
      price: toUnits(hype) / toUnits(tokens),
    };
  }

  if (b.topic0 === LAUNCHPAD_TOPICS.corepadTrade && NEURIIO_PADS.has(b.address)) {
    // Same layout as CorePad, with the token in topic1; amounts exclude the fee.
    const token = topicAddress(b.l.topic1);
    const m = token ? markets.get(token) : undefined;
    const w = [0, 1, 2, 4, 5].map((i) => word(b.data, i));
    if (!m || m.launchpad !== 'Neuriio' || w.some((x) => x === null)) return null;
    const [isBuy, quote, tokens, vQuote, vToken] = w.map((x) => wordUint(x as string));
    if (tokens === 0n || vToken === 0n) return null;
    return {
      ...common,
      token: m.token,
      venue: 'curve',
      trader: topicAddress(b.l.topic2),
      is_buy: isBuy === 1n,
      quote_amount: quote.toString(),
      token_amount: tokens.toString(),
      price: toUnits(vQuote, quoteDecimals(m.quote)) / toUnits(vToken),
    };
  }

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
      price: toUnits(quote, quoteDecimals(m.quote)) / toUnits(tokens),
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
      price: toUnits(quote, quoteDecimals(m.quote)) / toUnits(tokens),
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
      price: poolPrice(wordUint(w[2] as string), tokenIs0, m.quote, quoteAmt, tokenAmt),
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
      price: poolPrice(wordUint(w[2] as string), tokenIs0, m.quote, quoteAmt, tokenAmt),
    };
  }

  return null;
}

/** Which contracts may emit each launch topic (the same lists decodeLaunch checks). */
const LAUNCH_EMITTER_OF: Readonly<Record<string, (address: string) => boolean>> = {
  [LAUNCHPAD_TOPICS.chainzyLaunch]: (a) => EMITTERS.chainzy.has(a),
  [LAUNCHPAD_TOPICS.corepadLaunch]: (a) => EMITTERS.corepad.has(a),
  [LAUNCHPAD_TOPICS.signalCurveLaunch]: (a) => EMITTERS.signalCurve.has(a),
  [LAUNCHPAD_TOPICS.signalV4Launch]: (a) => EMITTERS.signalV4.has(a),
  [LAUNCHPAD_TOPICS.neuriioLaunch]: (a) => NEURIIO_PADS.has(a),
  [LAUNCHPAD_TOPICS.neuriioFtfLaunch]: (a) => NEURIIO_PADS.has(a),
  [LAUNCHPAD_TOPICS.akaPoolRegistered]: (a) => EMITTERS.akaHook.has(a),
  [LAUNCHPAD_TOPICS.bunnyLaunch]: (a) => EMITTERS.bunnyPad.has(a),
  [LAUNCHPAD_TOPICS.kilnLaunch]: (a) => EMITTERS.kilnFactory.has(a),
};

/** A log that was read and not stored, as the reject counts name it. */
export interface LogReject {
  reason: 'log-malformed' | 'log-undecodable' | 'launch-unknown-emitter' | 'market-unknown';
  sample: string;
}

function logSample(b: Base): string {
  return `emitter ${b.address} topic ${b.topic0.slice(0, 10)} tx ${b.txHash} log ${b.logIndex}`;
}

/**
 * Why a log carrying a launch topic gave no launch (call it when decodeLaunch returned null).
 * The one that matters is the unknown emitter: anyone can emit these topics on a testnet, and a
 * launchpad that deploys a new version of its contract looks exactly the same, so it is counted
 * with the address, for someone to tell which it is.
 */
export function launchRejectReason(raw: unknown): LogReject | null {
  const b = base(raw);
  if (!b) return { reason: 'log-malformed', sample: JSON.stringify(raw ?? null).slice(0, 300) };
  const allowed = LAUNCH_EMITTER_OF[b.topic0];
  if (!allowed) return null;
  return { reason: allowed(b.address) ? 'log-undecodable' : 'launch-unknown-emitter', sample: logSample(b) };
}

/**
 * Why a trade or graduation log named no market we know, when a launchpad's own contract
 * emitted it: the token traded there launched without us seeing it (call it when the decoder
 * returned null). Logs from anywhere else are not counted: a Swap of a pool that is not a
 * launch market is the normal case, and a curve nobody listed cannot be told from spam.
 */
export function marketRejectReason(raw: unknown, known: (key: string) => boolean): LogReject | null {
  const b = base(raw);
  if (!b) return { reason: 'log-malformed', sample: JSON.stringify(raw ?? null).slice(0, 300) };
  const padOwned =
    (b.topic0 === LAUNCHPAD_TOPICS.corepadTrade && (EMITTERS.bunnyPad.has(b.address) || NEURIIO_PADS.has(b.address))) ||
    (b.topic0 === LAUNCHPAD_TOPICS.signalRouterTrade && EMITTERS.signalRouter.has(b.address)) ||
    (b.topic0 === LAUNCHPAD_TOPICS.kilnGraduated && EMITTERS.kilnFactory.has(b.address)) ||
    (b.topic0 === LAUNCHPAD_TOPICS.neuriioGraduated && NEURIIO_PADS.has(b.address));
  if (!padOwned) return null;
  const key = topicAddress(b.l.topic1);
  if (key && known(key)) return null;
  return { reason: 'market-unknown', sample: `${logSample(b)} market ${key ?? '?'}` };
}

/**
 * Every value a log of `raw` can name its market by: the emitting contract, and its first indexed
 * argument read as an address (a token or a curve) and as 32 bytes (a V4 pool id). That is what
 * decodeLaunchTrade and decodeGraduation look a market up with, so the launches matching these
 * keys are all the decoders need for these logs.
 */
export function launchMarketCandidates(raw: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const r of raw) {
    const b = base(r);
    if (!b) continue;
    keys.add(b.address);
    const asAddress = topicAddress(b.l.topic1);
    if (asAddress) keys.add(asAddress);
    const asWord = lower(b.l.topic1);
    if (asWord) keys.add(asWord);
  }
  return [...keys];
}

/** Market keys a launch is traded under. */
export function launchMarketKeys(l: Pick<LaunchRow, 'token' | 'curve' | 'pool'> & { launchpad: string }): string[] {
  // A curve launch trades on its curve (on Neuriio: the token, inside the pad), then on its V2 pair once graduated.
  const curve = l.launchpad === 'Neuriio' || l.launchpad === 'BunnyPad' ? l.token : l.curve;
  return [curve, l.pool].filter((k): k is string => k !== null);
}

/**
 * The keys a launch graduates under: its curve contract where the curve emits the event
 * (CorePad, Signal), its token where the pad does (Neuriio, Kiln), prefixed with the pad so a
 * pad can only graduate its own tokens.
 *
 * Graduations were looked up with the keys a launch TRADES under (launchMarketKeys). A Kiln
 * launch trades on its curve and graduates by its token, so no Kiln graduation ever matched:
 * 468 of them in the provider's logs, none in our table (2026-11-11).
 */
export function launchGraduationKeys(l: Pick<LaunchRow, 'token' | 'curve'> & { launchpad: string }): string[] {
  if (l.launchpad === 'Neuriio' || l.launchpad === 'Kiln') return [`${l.launchpad}:${l.token}`];
  return l.curve ? [l.curve] : [];
}

/** The key a decoded graduation names its launch by, in the terms of launchGraduationKeys. */
export function graduationKey(g: GraduationRow): string | null {
  if (g.curve) return g.curve;
  return g.token && g.launchpad ? `${g.launchpad}:${g.token}` : null;
}

/** Topic order for one ingest window: launches first, so trades in the same window find their market. */
export const LAUNCH_TOPIC_ORDER = [
  LAUNCHPAD_TOPICS.chainzyLaunch,
  LAUNCHPAD_TOPICS.corepadLaunch,
  LAUNCHPAD_TOPICS.signalCurveLaunch,
  LAUNCHPAD_TOPICS.signalV4Launch,
  LAUNCHPAD_TOPICS.neuriioLaunch,
  LAUNCHPAD_TOPICS.neuriioFtfLaunch,
  LAUNCHPAD_TOPICS.akaPoolRegistered,
  LAUNCHPAD_TOPICS.bunnyLaunch,
  LAUNCHPAD_TOPICS.kilnLaunch,
] as const;
export const GRADUATION_TOPICS = [
  LAUNCHPAD_TOPICS.corepadGraduated,
  LAUNCHPAD_TOPICS.signalGraduated,
  LAUNCHPAD_TOPICS.neuriioGraduated,
  LAUNCHPAD_TOPICS.kilnGraduated,
] as const;
export const TRADE_TOPICS = [
  LAUNCHPAD_TOPICS.corepadTrade,
  LAUNCHPAD_TOPICS.signalRouterTrade,
  LAUNCHPAD_TOPICS.v2Swap,
  LAUNCHPAD_TOPICS.v3Swap,
  LAUNCHPAD_TOPICS.v4Swap,
  LAUNCHPAD_TOPICS.kilnBuy,
  LAUNCHPAD_TOPICS.kilnSell,
] as const;
