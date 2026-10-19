import { toUpstreamLog } from '../../../src/services/elysium/elysium-rpc-logs';
import { decodeGraduation } from '../../../src/services/elysium/elysium-launchpad.util';

/** A real Neuriio Graduated log as eth_getLogs returns it on the Kinetiq RPC. */
const rpcLog = {
  address: '0xD9943d81B72aA55E52580bBb595af797B04d5E59',
  topics: [
    '0x487dc7f66c623fb0ff13f9024a3ff9675453d069e075eceb12d9f8d7870e2374',
    '0x000000000000000000000000e37c75b2fcfff1d3ac963552a556e6b78b6d5137',
    '0x000000000000000000000000d53a1901004dae187fbc333c9925b40ba44495eb',
  ],
  data: '0x00000000000000000000000000000000000000000000000003eeaa698b48ec28000000000000000000000000000000000000000000ab24c7796fd2da3880000000000000000000000000000000000000000000000000019f12563854b6172d2e',
  blockNumber: '0x520cb2',
  transactionHash: '0x064C05556D9D619FCD940CB04EFABFBCE8E3C08C486AE337EEFBDD0258762AC8',
  logIndex: '0x3',
  blockTimestamp: '0x6ac7c600',
  removed: false,
};

describe('elysium RPC logs', () => {
  it('maps an RPC log to the provider row shape the decoders read', () => {
    const row = toUpstreamLog(rpcLog);
    expect(row).toMatchObject({
      block_number: 0x520cb2,
      log_index: 3,
      address: '0xd9943d81b72aa55e52580bbb595af797b04d5e59',
      tx_hash: '0x064c05556d9d619fcd940cb04efabfbce8e3c08c486ae337eefbdd0258762ac8',
      topic3: '',
    });
    expect(row?.block_time).toBe(new Date(0x6ac7c600 * 1000).toISOString());
    expect(decodeGraduation(row)).toMatchObject({ token: '0xe37c75b2fcfff1d3ac963552a556e6b78b6d5137' });
  });

  it('drops reorged logs and logs without a block timestamp', () => {
    expect(toUpstreamLog({ ...rpcLog, removed: true })).toBeNull();
    expect(toUpstreamLog({ ...rpcLog, blockTimestamp: undefined })).toBeNull();
  });
});

describe('elysium RPC block search', () => {
  const HEAD = 50_000;
  /** Block 0 at time 0 (as on Arbitrum), then uneven 100-300 ms blocks from a fixed start. */
  const times: number[] = [0];
  let t = 1_760_000_000_000;
  for (let n = 1; n <= HEAD; n++) {
    t += 100 + ((n * 7919) % 200);
    times.push(Math.floor(t / 1000));
  }

  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const { method, params } = JSON.parse(String((init as RequestInit).body)) as { method: string; params: unknown[] };
      const result =
        method === 'eth_blockNumber'
          ? `0x${HEAD.toString(16)}`
          : { timestamp: `0x${times[parseInt(String(params[0]), 16)].toString(16)}` };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('finds the last block at or before a time despite the zero-time genesis block', async () => {
    // A fresh module instance, so no memo leaks between tests.
    const { ElysiumRpcLogs } = jest.requireActual<typeof import('../../../src/services/elysium/elysium-rpc-logs')>(
      '../../../src/services/elysium/elysium-rpc-logs'
    );
    const rpc = ElysiumRpcLogs.getInstance() as unknown as { blockAtOrBefore(ts: number): Promise<number> };
    for (const target of [12_345, 40_001]) {
      const block = await rpc.blockAtOrBefore(times[target]);
      expect(times[block]).toBeLessThanOrEqual(times[target]);
      expect(Math.abs(block - target)).toBeLessThanOrEqual(10);
    }
  });
});
