import { z } from 'zod';

/**
 * JSON-RPC methods the Elysium builder tools (Simulator, Decoder, Network,
 * Transaction inspector) need, all read-only. The proxy forwards ONLY these:
 * no eth_sendRawTransaction / eth_sendTransaction (writes go through the user's
 * own wallet, never our keyed RPC), and no debug_/trace_/admin_/personal_/
 * txpool_/miner_/engine_ (the archive RPC does not expose them anyway).
 */
export const ELYSIUM_RPC_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBlockReceipts',
  'eth_call',
  'eth_estimateGas',
  'eth_simulateV1',
  'eth_createAccessList',
  'eth_getCode',
  'eth_getBalance',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getProof',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getLogs',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'net_version',
  'net_listening',
  'web3_clientVersion',
]);

/**
 * Calls in one request. The builder tools send single calls (viem folds their
 * contract reads into one Multicall3 `eth_call`), so a batch is only a
 * convenience for other clients; each call in it counts against the caller's
 * rate limit (elysiumRpcRateLimiter).
 */
export const ELYSIUM_RPC_MAX_BATCH = 20;

/** Contracts one `eth_getLogs` may name. */
const MAX_LOG_ADDRESSES = 10;
/** The JSON-RPC spec's own ceiling for `eth_feeHistory`. */
const MAX_FEE_HISTORY_BLOCKS = 1024;
const MAX_FEE_HISTORY_PERCENTILES = 20;
const MAX_PROOF_STORAGE_KEYS = 32;
/** The tools simulate one block of a handful of calls. */
const MAX_SIMULATED_BLOCKS = 4;
const MAX_SIMULATED_CALLS_PER_BLOCK = 64;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON-RPC quantity (number, or 0x hex string) as a number; NaN when it is neither. */
function quantity(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,12}$/.test(v)) return parseInt(v, 16);
  return NaN;
}

/**
 * What makes a call too heavy for the shared archive node, or null. Only the
 * parameters that size the node's work are checked; everything else is the
 * node's own to validate.
 *
 * - `eth_getLogs` must name its contract(s) or one block (`blockHash`): without
 *   either, a filter scans every log of the block range, and the range is the
 *   caller's to pick (`earliest` to `latest`). With an address the tools do read
 *   wide ranges (the token checker up to 2M blocks, the trust page from block 0),
 *   so the range itself stays free.
 * - `eth_feeHistory`, `eth_getProof` and `eth_simulateV1` take a count or a
 *   list the caller sizes.
 */
export function elysiumRpcParamsIssue(method: string, params: readonly unknown[] | undefined): string | null {
  if (method === 'eth_getLogs') {
    const filter = params?.[0];
    if (!isRecord(filter)) return 'eth_getLogs needs a filter object';
    if (typeof filter.blockHash === 'string' && filter.blockHash !== '') return null;
    const address = filter.address;
    const named =
      typeof address === 'string'
        ? ADDRESS.test(address)
        : Array.isArray(address) &&
          address.length >= 1 &&
          address.length <= MAX_LOG_ADDRESSES &&
          address.every((a) => typeof a === 'string' && ADDRESS.test(a));
    return named ? null : `eth_getLogs needs an address (at most ${MAX_LOG_ADDRESSES}) or a blockHash`;
  }
  if (method === 'eth_feeHistory') {
    const blocks = quantity(params?.[0]);
    if (!(blocks >= 1 && blocks <= MAX_FEE_HISTORY_BLOCKS)) {
      return `eth_feeHistory blockCount must be 1 to ${MAX_FEE_HISTORY_BLOCKS}`;
    }
    const percentiles = params?.[2];
    if (Array.isArray(percentiles) && percentiles.length > MAX_FEE_HISTORY_PERCENTILES) {
      return `eth_feeHistory takes at most ${MAX_FEE_HISTORY_PERCENTILES} percentiles`;
    }
    return null;
  }
  if (method === 'eth_getProof') {
    const keys = params?.[1];
    if (Array.isArray(keys) && keys.length > MAX_PROOF_STORAGE_KEYS) {
      return `eth_getProof takes at most ${MAX_PROOF_STORAGE_KEYS} storage keys`;
    }
    return null;
  }
  if (method === 'eth_simulateV1') {
    const payload = params?.[0];
    const blocks = isRecord(payload) ? payload.blockStateCalls : undefined;
    if (!Array.isArray(blocks)) return null;
    if (blocks.length > MAX_SIMULATED_BLOCKS) return `eth_simulateV1 takes at most ${MAX_SIMULATED_BLOCKS} blocks`;
    for (const block of blocks) {
      if (isRecord(block) && Array.isArray(block.calls) && block.calls.length > MAX_SIMULATED_CALLS_PER_BLOCK) {
        return `eth_simulateV1 takes at most ${MAX_SIMULATED_CALLS_PER_BLOCK} calls a block`;
      }
    }
    return null;
  }
  return null;
}

const rpcCall = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: z.union([z.number(), z.string(), z.null()]).optional(),
    method: z
      .string()
      .max(64)
      .refine((m) => ELYSIUM_RPC_ALLOWED_METHODS.has(m), { message: 'Method not allowed' }),
    // params shapes are the RPC's own; bound the length so a batch can't smuggle a huge payload.
    params: z.array(z.unknown()).max(10).optional(),
  })
  .superRefine((call, ctx) => {
    const issue = elysiumRpcParamsIssue(call.method, call.params);
    if (issue) ctx.addIssue({ code: 'custom', path: ['params'], message: issue });
  });

/** One JSON-RPC call, or a small batch. */
export const elysiumRpcBodySchema = z.object({
  body: z.union([rpcCall, z.array(rpcCall).min(1).max(ELYSIUM_RPC_MAX_BATCH)]),
});
