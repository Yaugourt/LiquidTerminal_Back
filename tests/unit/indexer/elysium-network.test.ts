import { HypeDexerElysiumIndexerClient } from '../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client';
import { elysiumBlocksQuerySchema, elysiumTokenHoldersSchema } from '../../../src/schemas/indexer/elysium-indexer.schema';

describe('Elysium pass-through network', () => {
  const client = HypeDexerElysiumIndexerClient.getInstance() as unknown as {
    getUnwrapped: (path: string) => Promise<unknown>;
    getBlocks: (q: object) => Promise<unknown>;
    getTokenHolders: (a: string, q: object) => Promise<unknown>;
  };
  let paths: string[] = [];
  beforeEach(() => {
    paths = [];
    jest.spyOn(client, 'getUnwrapped').mockImplementation(async (path: string) => {
      paths.push(path);
      return [];
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads testnet by default and mainnet on request, never forwarding the network param', async () => {
    await client.getBlocks({ limit: 5 });
    await client.getBlocks({ limit: 5, network: 'mainnet' });
    await client.getTokenHolders('0xabc', { network: 'mainnet', limit: 10 });
    expect(paths).toEqual([
      '/elysium/testnet/blocks?limit=5',
      '/elysium/mainnet/blocks?limit=5',
      '/elysium/mainnet/tokens/0xabc/holders?limit=10',
    ]);
  });

  it('accepts only the two networks', () => {
    expect(elysiumBlocksQuerySchema.shape.query.safeParse({ network: 'mainnet' }).success).toBe(true);
    expect(elysiumBlocksQuerySchema.shape.query.safeParse({ network: 'devnet' }).success).toBe(false);
    expect(
      elysiumTokenHoldersSchema.safeParse({ query: { limit: '10' }, params: { address: '0x' + 'a'.repeat(40) } }).success
    ).toBe(true);
  });
});
