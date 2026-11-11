import {
  elysiumRpcBodySchema,
  elysiumRpcParamsIssue,
  ELYSIUM_RPC_ALLOWED_METHODS,
  ELYSIUM_RPC_MAX_BATCH,
  elysiumRpcCallWeight,
  elysiumRpcRequestWeight,
} from '../../../src/schemas/elysium-rpc.schema';

const parse = (body: unknown) => elysiumRpcBodySchema.safeParse({ body });
const ok = (method: string, params: unknown[]) => parse({ jsonrpc: '2.0', id: 1, method, params }).success;

const TOKEN = '0x' + 'ab'.repeat(20);
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
    expect(parse(Array.from({ length: ELYSIUM_RPC_MAX_BATCH }, () => ({ method: 'eth_chainId' }))).success).toBe(true);
    expect(parse(Array.from({ length: ELYSIUM_RPC_MAX_BATCH + 1 }, () => ({ method: 'eth_chainId' }))).success).toBe(false);
    expect(parse({ method: 42 }).success).toBe(false);
  });

  describe('eth_getLogs', () => {
    it('refuses a filter that names no contract and no block', () => {
      expect(ok('eth_getLogs', [{ fromBlock: 'earliest', toBlock: 'latest' }])).toBe(false);
      expect(ok('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2', topics: [TOPIC] }])).toBe(false);
      expect(ok('eth_getLogs', [{ address: [] }])).toBe(false);
      expect(ok('eth_getLogs', [{ address: 'not-an-address' }])).toBe(false);
      expect(ok('eth_getLogs', [{ address: null }])).toBe(false);
      expect(ok('eth_getLogs', [{ blockHash: '' }])).toBe(false);
      expect(ok('eth_getLogs', [])).toBe(false);
      expect(ok('eth_getLogs', ['latest'])).toBe(false);
    });

    it('caps the contracts of one filter', () => {
      expect(ok('eth_getLogs', [{ address: Array.from({ length: 10 }, () => TOKEN) }])).toBe(true);
      expect(ok('eth_getLogs', [{ address: Array.from({ length: 11 }, () => TOKEN) }])).toBe(false);
      expect(ok('eth_getLogs', [{ address: [TOKEN, 'nope'] }])).toBe(false);
    });

    it('lets the builder tools read as they do', () => {
      // Token checker: one token, a span it picks (up to 2M blocks), the Transfer topic.
      expect(ok('eth_getLogs', [{ address: TOKEN, fromBlock: '0x1', toBlock: '0x1e8480', topics: [TOPIC] }])).toBe(true);
      // Trust page (viem getLogs): one contract from block 0 to the head.
      expect(ok('eth_getLogs', [{ address: TOKEN, topics: [TOPIC], fromBlock: '0x0', toBlock: 'latest' }])).toBe(true);
      // One block by hash, every contract.
      expect(ok('eth_getLogs', [{ blockHash: '0x' + '11'.repeat(32) }])).toBe(true);
    });
  });

  it('bounds eth_feeHistory', () => {
    expect(ok('eth_feeHistory', ['0x400', 'latest', [25, 50, 75]])).toBe(true);
    expect(ok('eth_feeHistory', [1024, 'latest', []])).toBe(true);
    expect(ok('eth_feeHistory', ['0x401', 'latest', []])).toBe(false);
    expect(ok('eth_feeHistory', ['0xffffffffffffffffffff', 'latest', []])).toBe(false);
    expect(ok('eth_feeHistory', [0, 'latest', []])).toBe(false);
    expect(ok('eth_feeHistory', ['latest'])).toBe(false);
    expect(ok('eth_feeHistory', [10, 'latest', Array.from({ length: 21 }, (_, i) => i)])).toBe(false);
  });

  it('bounds eth_getProof storage keys', () => {
    expect(ok('eth_getProof', [TOKEN, Array.from({ length: 32 }, () => '0x0'), 'latest'])).toBe(true);
    expect(ok('eth_getProof', [TOKEN, Array.from({ length: 33 }, () => '0x0'), 'latest'])).toBe(false);
  });

  it('bounds eth_simulateV1 and lets the simulator shapes through', () => {
    const call = { from: TOKEN, to: TOKEN, data: '0x' };
    // Simulator: one block, a balance override, native transfers traced.
    expect(
      ok('eth_simulateV1', [
        { blockStateCalls: [{ stateOverrides: { [TOKEN]: { balance: '0x1' } }, calls: [call, call] }], traceTransfers: true, validation: false },
        'latest',
      ])
    ).toBe(true);
    // Token checker: one block of calls.
    expect(ok('eth_simulateV1', [{ blockStateCalls: [{ calls: [call, call, call] }], validation: false }, 'latest'])).toBe(true);
    expect(ok('eth_simulateV1', [{ blockStateCalls: Array.from({ length: 5 }, () => ({ calls: [call] })) }, 'latest'])).toBe(false);
    expect(ok('eth_simulateV1', [{ blockStateCalls: [{ calls: Array.from({ length: 65 }, () => call) }] }, 'latest'])).toBe(false);
  });

  it('checks every call of a batch', () => {
    expect(parse([{ method: 'eth_chainId' }, { method: 'eth_getLogs', params: [{ fromBlock: 'earliest' }] }]).success).toBe(false);
  });

  it('weighs a call by the work its parameters size', () => {
    const call = { from: TOKEN, to: TOKEN, data: '0x' };
    expect(elysiumRpcCallWeight('eth_blockNumber', undefined)).toBe(1);
    expect(elysiumRpcCallWeight('eth_call', [{ to: TOKEN, data: '0x' }, 'latest'])).toBe(1);
    // One per simulated call, an empty block still one.
    expect(elysiumRpcCallWeight('eth_simulateV1', [{ blockStateCalls: [{ calls: [call, call, call] }] }, 'latest'])).toBe(3);
    expect(elysiumRpcCallWeight('eth_simulateV1', [{ blockStateCalls: [{ calls: Array.from({ length: 64 }, () => call) }, { calls: [] }, {}] }, 'latest'])).toBe(66);
    expect(elysiumRpcCallWeight('eth_simulateV1', [])).toBe(1);
    expect(elysiumRpcCallWeight('eth_getLogs', [{ address: TOKEN, fromBlock: '0x0', toBlock: 'latest' }])).toBe(5);
    expect(elysiumRpcCallWeight('eth_getLogs', [{ blockHash: '0x' + 'ab'.repeat(32) }])).toBe(2);
    expect(elysiumRpcCallWeight('eth_getBlockReceipts', ['latest'])).toBe(3);
    expect(elysiumRpcCallWeight('eth_getBlockByNumber', ['0x1', true])).toBe(2);
    expect(elysiumRpcCallWeight('eth_getBlockByNumber', ['0x1', false])).toBe(1);
    expect(elysiumRpcCallWeight('eth_getProof', [TOKEN, Array.from({ length: 32 }, () => '0x0'), 'latest'])).toBe(5);
    expect(elysiumRpcCallWeight('eth_getProof', [TOKEN, [], 'latest'])).toBe(1);
    expect(elysiumRpcCallWeight('eth_feeHistory', ['0x400', 'latest', []])).toBe(9);
    expect(elysiumRpcCallWeight('eth_feeHistory', [4, 'latest', []])).toBe(1);
  });

  it('weighs a request as its calls together', () => {
    const plain = { jsonrpc: '2.0', id: 1, method: 'eth_chainId' };
    const logs = { jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{ address: TOKEN }] };
    expect(elysiumRpcRequestWeight(plain)).toBe(1);
    expect(elysiumRpcRequestWeight([plain, plain, logs])).toBe(7);
    expect(elysiumRpcRequestWeight(Array.from({ length: 20 }, () => plain))).toBe(20);
    // Never below one unit, whatever reaches it.
    expect(elysiumRpcRequestWeight(null)).toBe(1);
  });

  it('leaves the other methods to the node', () => {
    expect(elysiumRpcParamsIssue('eth_call', [{ to: TOKEN, data: '0x' }, 'latest', { [TOKEN]: { code: '0x00' } }])).toBeNull();
    expect(elysiumRpcParamsIssue('eth_getBlockByNumber', ['0x1', true])).toBeNull();
    expect(elysiumRpcParamsIssue('eth_blockNumber', undefined)).toBeNull();
  });
});
