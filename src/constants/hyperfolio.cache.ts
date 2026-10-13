import { positiveIntEnv } from '../utils/env';

/**
 * Redis cache keys and TTLs for the Hyperfolio proxy.
 *
 * Hyperfolio enforces a per-second burst limit (403) and quota limits (429),
 * and already caches most wallet answers upstream. Minutes-long TTLs keep one
 * wallet page view from fanning out into a dozen upstream calls on every poll.
 */
export const HYPERFOLIO_CACHE_PREFIX = 'hyperfolio' as const;

const wallet = (address: string): string => address.toLowerCase();

export const HYPERFOLIO_CACHE_KEYS = {
  composition: (address: string) => `${HYPERFOLIO_CACHE_PREFIX}:composition:${wallet(address)}`,
  positions: (address: string) => `${HYPERFOLIO_CACHE_PREFIX}:positions:${wallet(address)}`,
  history: (address: string, days: number) =>
    `${HYPERFOLIO_CACHE_PREFIX}:history:${wallet(address)}:${days}`,
  transactions: (address: string, querySignature: string) =>
    `${HYPERFOLIO_CACHE_PREFIX}:transactions:${wallet(address)}:${querySignature}`,
  nfts: (address: string, querySignature: string) =>
    `${HYPERFOLIO_CACHE_PREFIX}:nfts:${wallet(address)}:${querySignature}`,
  points: (address: string) => `${HYPERFOLIO_CACHE_PREFIX}:points:${wallet(address)}`,
  yield: (querySignature: string) => `${HYPERFOLIO_CACHE_PREFIX}:yield:${querySignature}`,
} as const;

/**
 * TTLs in seconds. Each key also keeps a last copy (cacheService: ~10 TTLs,
 * at most 10 min, since most keys are per wallet) served, flagged `stale`,
 * when a refresh is refused by the guards or fails upstream.
 */
export const HYPERFOLIO_TTL = {
  composition: 60, // token balances move with the market
  positions: 120, // DeFi positions, upstream fan-out is 30+ protocols
  history: 300, // daily snapshots
  transactions: 120, // per page/filter; cold upstream fetch can take 30 s
  nfts: 600, // upstream caches 2 h itself
  points: 300,
  yield: 120, // global list, shared by every visitor
} as const;

/**
 * Streaming positions. Each open stream is one long upstream call; how fast
 * new ones start is bounded by the client's process-wide 8/s. The caps only
 * bound concurrent ones: 30 per IP (dozens of people behind one address) and
 * 500 in all; past them the route answers 503 with a short Retry-After.
 */
export const HYPERFOLIO_STREAM = {
  MAX_CONNECTIONS_PER_IP: positiveIntEnv('HYPERFOLIO_STREAMS_PER_IP', 30),
  MAX_TOTAL_CONNECTIONS: positiveIntEnv('HYPERFOLIO_STREAMS_TOTAL', 500),
  /** Seconds a client over the caps is told to wait before retrying. */
  RETRY_AFTER_S: 3,
  HEARTBEAT_INTERVAL_MS: 15_000,
  UPSTREAM_TIMEOUT_MS: 90_000,
} as const;
