import { elysiumRpcBodySchema, ELYSIUM_RPC_ALLOWED_METHODS } from '../../../src/schemas/elysium-rpc.schema';

const parse = (body: unknown) => elysiumRpcBodySchema.safeParse({ body });

describe('elysium rpc proxy schema', () => {
  it('allows read-only methods, single and batched', () => {
    expect(parse({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }).success).toBe(true);
    expect(parse({ method: 'eth_simulateV1', params: [{ blockStateCalls: [] }, 'latest'] }).success).toBe(true);
    expect(parse([{ method: 'eth_call', params: [{}, 'latest'] }, { method: 'eth_getCode', params: ['0x00', '0x1'] }]).success).toBe(true);
  });

  it('rejects writes, debug/admin, and unknown methods', () => {
    for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'debug_traceTransaction', 'debug_traceBlockByNumber', 'admin_peers', 'personal_sign', 'txpool_content', 'evm_mine']) {
      expect(parse({ method: m, params: [] }).success).toBe(false);
      expect(ELYSIUM_RPC_ALLOWED_METHODS.has(m)).toBe(false);
    }
  });

  it('rejects an empty or oversized batch, and a non-string method', () => {
    expect(parse([]).success).toBe(false);
    expect(parse(Array.from({ length: 101 }, () => ({ method: 'eth_chainId' }))).success).toBe(false);
    expect(parse({ method: 42 }).success).toBe(false);
  });
});
