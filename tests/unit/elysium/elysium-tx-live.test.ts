import { ElysiumRpcLogs } from '../../../src/services/elysium/elysium-rpc-logs';
import { normalizeLiveTx } from '../../../src/services/elysium/elysium-ingest.util';

const WATCHED = new Set(['0x90332b0ecbb2c9517f405627b0dd5d5265246563']);
const BLOCK = { number: 13_545_909, timestamp: 1_792_670_000 };

describe('elysium live tx fallback', () => {
  it('keeps a call to a watched contract, lowercased, timed by its block', () => {
    const row = normalizeLiveTx(
      { hash: '0xABC', from: '0xF26F5551E96AE5162509B25925FFFA7F07B2D652', to: '0x90332B0ECBB2C9517F405627B0DD5D5265246563' },
      BLOCK,
      WATCHED
    );
    expect(row).toEqual({
      tx_hash: '0xabc',
      block_number: '13545909',
      block_time: new Date(BLOCK.timestamp * 1000).toISOString(),
      from_addr: '0xf26f5551e96ae5162509b25925fffa7f07b2d652',
      to_addr: '0x90332b0ecbb2c9517f405627b0dd5d5265246563',
    });
  });

  it('drops system txs, deployments and calls to other contracts', () => {
    const from = '0xf26f5551e96ae5162509b25925fffa7f07b2d652';
    expect(normalizeLiveTx({ hash: '0x1', from, to: '0x00000000000000000000000000000000000a4b05' }, BLOCK, WATCHED)).toBeNull();
    expect(normalizeLiveTx({ hash: '0x2', from, to: null }, BLOCK, WATCHED)).toBeNull();
    expect(normalizeLiveTx({ hash: '0x3', from, to: '0x90332b0ecbb2c9517f405627b0dd5d5265246563' }, { ...BLOCK, timestamp: 0 }, WATCHED)).toBeNull();
  });

  describe('batched block reads', () => {
    afterEach(() => jest.restoreAllMocks());

    it('returns only the leading run of answered blocks, so no block is skipped', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        const batch = JSON.parse(String((init as RequestInit).body)) as Array<{ id: number; params: [string, boolean] }>;
        // The RPC refuses the third item of the burst.
        const replies = batch.map((item) =>
          item.id === 2
            ? { jsonrpc: '2.0', id: item.id, error: { code: -32017, message: 'Rate Limit Exceeded' } }
            : {
                jsonrpc: '2.0',
                id: item.id,
                result: { number: item.params[0], timestamp: '0x6ad5b4b0', transactions: [{ hash: '0x1', from: '0xa', to: '0xb' }] },
              }
        );
        return new Response(JSON.stringify(replies));
      });
      const blocks = await ElysiumRpcLogs.getInstance().getBlocks(100, 5);
      expect(blocks.map((b) => b.number)).toEqual([100, 101]);
      expect(blocks[0].transactions).toHaveLength(1);
    });
  });
});
