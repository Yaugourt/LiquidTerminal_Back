import { ElysiumRpcLogs, toUpstreamLog } from '../../../src/services/elysium/elysium-rpc-logs';
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

  it('drops reorged logs; a log without a block timestamp takes the time of its block', () => {
    expect(toUpstreamLog({ ...rpcLog, removed: true })).toBeNull();
    expect(toUpstreamLog({ ...rpcLog, blockTimestamp: undefined })).toBeNull();
    expect(toUpstreamLog({ ...rpcLog, blockTimestamp: undefined }, 1_791_476_224)?.block_time).toBe(
      new Date(1_791_476_224_000).toISOString()
    );
  });
});

describe('elysium RPC logs returned without their block time', () => {
  const BLOCK_TIME = 1_762_862_400; // 2026-11-11T12:00:00Z
  /** How many times each block was read. */
  let blockReads: Map<number, number>;
  const serve = (logs: unknown[]): void => {
    blockReads = new Map();
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const { method, params } = JSON.parse(String((init as RequestInit).body)) as { method: string; params: unknown[] };
      let result: unknown;
      if (method === 'eth_blockNumber') result = '0x3e8';
      else if (method === 'eth_getLogs') result = logs;
      else {
        const n = parseInt(String(params[0]), 16);
        blockReads.set(n, (blockReads.get(n) ?? 0) + 1);
        result = { timestamp: `0x${(n === 0 ? 0 : BLOCK_TIME - 1000 + n).toString(16)}` };
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  };
  const fresh = (): ElysiumRpcLogs => {
    (ElysiumRpcLogs as unknown as { instance?: unknown }).instance = undefined;
    return ElysiumRpcLogs.getInstance();
  };
  afterEach(() => {
    jest.restoreAllMocks();
    // The instance remembers block times: the next tests get one of their own.
    (ElysiumRpcLogs as unknown as { instance?: unknown }).instance = undefined;
  });

  it('reads the block of such a log, once per block, and keeps the log', async () => {
    const at = (block: number, index: number) => ({ ...rpcLog, blockTimestamp: undefined, blockNumber: `0x${block.toString(16)}`, logIndex: `0x${index.toString(16)}` });
    serve([at(500, 0), at(500, 1), at(501, 0)]);
    const rpc = fresh();
    const start = new Date((BLOCK_TIME - 1000 + 400) * 1000);
    const end = new Date((BLOCK_TIME - 1000 + 600) * 1000);

    const rows = await rpc.getLogs(String(rpcLog.topics[0]), start, end);

    expect(rows.map((r) => [r.block_number, r.log_index, r.block_time])).toEqual([
      [500, 0, new Date((BLOCK_TIME - 500) * 1000).toISOString()],
      [500, 1, new Date((BLOCK_TIME - 500) * 1000).toISOString()],
      [501, 0, new Date((BLOCK_TIME - 499) * 1000).toISOString()],
    ]);
    expect([blockReads.get(500), blockReads.get(501)]).toEqual([1, 1]);
  });

  it('fails the read, rather than leave the logs out, when too many blocks would have to be read', async () => {
    serve(Array.from({ length: 260 }, (_, i) => ({ ...rpcLog, blockTimestamp: undefined, blockNumber: `0x${(300 + i).toString(16)}` })));
    const rpc = fresh();
    const start = new Date((BLOCK_TIME - 1000 + 250) * 1000);
    const end = new Date((BLOCK_TIME - 1000 + 700) * 1000);
    await expect(rpc.getLogs(String(rpcLog.topics[0]), start, end)).rejects.toThrow('without their block time');
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

describe('elysium RPC logs over a busy range', () => {
  /** One log every 10 blocks; the mock refuses any range holding more than 1,000 of them. */
  const CAP = 1_000;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const { params } = JSON.parse(String((init as RequestInit).body)) as { params: [{ fromBlock: string; toBlock: string }] };
      calls++;
      const lo = parseInt(params[0].fromBlock, 16);
      const hi = parseInt(params[0].toBlock, 16);
      const blocks: number[] = [];
      for (let b = Math.ceil(lo / 10) * 10; b <= hi; b += 10) blocks.push(b);
      if (blocks.length > CAP) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'logs count limit exceeded (10000) consider refine/narrow down your query' } })
        );
      }
      const result = blocks.map((b) => ({
        ...rpcLog,
        blockNumber: `0x${b.toString(16)}`,
        blockTimestamp: `0x${(1_760_000_000 + b).toString(16)}`,
      }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('splits a refused range until it fits, without losing or repeating a log', async () => {
    const { ElysiumRpcLogs } = jest.requireActual<typeof import('../../../src/services/elysium/elysium-rpc-logs')>(
      '../../../src/services/elysium/elysium-rpc-logs'
    );
    const rpc = new (ElysiumRpcLogs as unknown as new () => { logsInRange(t: string, lo: number, hi: number): Promise<{ blockNumber: string }[]> })();
    const logs = await rpc.logsInRange(rpcLog.topics[0], 0, 99_999);
    const blocks = logs.map((l) => parseInt(l.blockNumber, 16));
    expect(blocks).toHaveLength(10_000);
    expect(new Set(blocks).size).toBe(10_000);
    expect(blocks).toEqual([...blocks].sort((a, b) => a - b));
    // Refused once per level on the way down, never retried on the same range.
    expect(calls).toBeLessThan(40);
  });
});
