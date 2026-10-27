/**
 * Copying a public wallet list names the copy "<name> (Copy)"; names are unique per
 * user, so copying the same list twice answered 409. The copy takes the first free
 * "(Copy)", "(Copy 2)", "(Copy 3)"... instead, within the name length limit.
 */
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/cache.service', () => ({ cacheService: {} }));
jest.mock('../../../src/services/xp/xp.service', () => ({
  xpService: { grantXp: jest.fn().mockResolvedValue(undefined) },
}));

import { WalletListService } from '../../../src/services/walletlist/walletlist.service';
import { walletListCreateSchema, WALLET_LIST_NAME_MAX } from '../../../src/schemas/walletlist.schema';

type Internals = {
  repository: { findById: jest.Mock; existsByNameAndUser: jest.Mock };
  create: jest.Mock;
};

const original = (name: string) => ({
  id: 1,
  name,
  description: null,
  isPublic: true,
  creator: { id: 1, name: 'owner' },
  items: [],
});

function makeService(name: string, taken: string[]) {
  const service = new WalletListService();
  const internals = service as unknown as Internals;
  internals.repository = {
    findById: jest.fn().mockResolvedValueOnce(original(name)).mockResolvedValue({ id: 2, items: [] }),
    existsByNameAndUser: jest.fn(async (candidate: string) => taken.includes(candidate)),
  };
  internals.create = jest.fn().mockResolvedValue({ id: 2 });
  return { service, internals };
}

const createdName = (internals: Internals): string => internals.create.mock.calls[0][0].name;

describe('WalletListService.copyWalletList name', () => {
  it('names the first copy "<name> (Copy)"', async () => {
    const { service, internals } = makeService('Whales', []);

    await service.copyWalletList(1, 99);

    expect(createdName(internals)).toBe('Whales (Copy)');
    expect(internals.repository.existsByNameAndUser).toHaveBeenCalledWith('Whales (Copy)', 99);
  });

  it('takes the next free number when the user already has the earlier copies', async () => {
    const { service, internals } = makeService('Whales', ['Whales (Copy)', 'Whales (Copy 2)']);

    await service.copyWalletList(1, 99);

    expect(createdName(internals)).toBe('Whales (Copy 3)');
  });

  it('fills a gap: takes the first free name, not the last number + 1', async () => {
    const { service, internals } = makeService('Whales', ['Whales (Copy)', 'Whales (Copy 3)']);

    await service.copyWalletList(1, 99);

    expect(createdName(internals)).toBe('Whales (Copy 2)');
  });

  it('trims a long base name so the copy name stays valid for the create schema', async () => {
    const long = 'x'.repeat(WALLET_LIST_NAME_MAX);
    const { service, internals } = makeService(long, [`${'x'.repeat(WALLET_LIST_NAME_MAX - 7)} (Copy)`]);

    await service.copyWalletList(1, 99);

    const name = createdName(internals);
    expect(name).toBe(`${'x'.repeat(WALLET_LIST_NAME_MAX - 9)} (Copy 2)`);
    expect(name).toHaveLength(WALLET_LIST_NAME_MAX);
    expect(walletListCreateSchema.safeParse({ name, userId: 99 }).success).toBe(true);
  });

  it('gives up after 50 names and lets create answer alreadyExists with the first one', async () => {
    const taken = ['Whales (Copy)', ...Array.from({ length: 49 }, (_, i) => `Whales (Copy ${i + 2})`)];
    const { service, internals } = makeService('Whales', taken);

    await service.copyWalletList(1, 99);

    expect(internals.repository.existsByNameAndUser).toHaveBeenCalledTimes(50);
    expect(createdName(internals)).toBe('Whales (Copy)');
  });
});
