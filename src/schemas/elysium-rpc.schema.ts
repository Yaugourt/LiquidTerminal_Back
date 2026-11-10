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

const rpcCall = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z
    .string()
    .max(64)
    .refine((m) => ELYSIUM_RPC_ALLOWED_METHODS.has(m), { message: 'Method not allowed' }),
  // params shapes are the RPC's own; bound the length so a batch can't smuggle a huge payload.
  params: z.array(z.unknown()).max(10).optional(),
});

/** One JSON-RPC call, or a small batch (viem batches reads). */
export const elysiumRpcBodySchema = z.object({
  body: z.union([rpcCall, z.array(rpcCall).min(1).max(100)]),
});
