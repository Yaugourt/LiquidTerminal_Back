/**
 * Service-level regressions for the call sites converted to runWithTx (see also
 * tx-scope.regression.test.ts for BaseService and WalletService.addWallet).
 *
 * For each: the repositories bound to the transaction are exactly the expected
 * ones while the body runs, a body that throws leaves every repository on its own
 * client (a read right after goes to the default client, not to a closed
 * transaction), cache flushes that moved after the commit do not run when the body
 * throws and do run after a successful commit, and the read-then-write methods that
 * no longer wrap their reads in a transaction open no outer one.
 *
 * The fake clients throw like Prisma when a transaction client is used after its
 * block ended, and record which client served each query.
 */
type FakeDb = { label: string } & Record<string, Record<string, (args?: unknown) => Promise<unknown>>>;

const mockQueries: string[] = [];
// Chronological: 'commit:<tx>' / 'rollback:<tx>' of every transaction, 'flush' of every cache invalidation
const mockEvents: string[] = [];
// Canned answers by '<kind>/<model>.<method>', kind = default | content | tx | ctx
const mockAnswers: Record<string, unknown> = {};
let mockCoreTxCount = 0;
let mockContentTxCount = 0;

function mockMakeDb(label: string, isClosed: () => boolean): FakeDb {
  const kind = label.replace(/\d+$/, '');
  const isDefault = kind === 'default' || kind === 'content';
  return new Proxy({ label } as FakeDb, {
    get(target, model) {
      if (typeof model === 'string' && model in target) return target[model]; // label, $transaction
      if (typeof model === 'symbol' || model === 'then') return undefined;
      return new Proxy(
        {},
        {
          get(_, method) {
            if (typeof method === 'symbol' || method === 'then') return undefined;
            return async (args?: { where?: { id?: number } }) => {
              if (isClosed()) {
                throw new Error('P2028 Transaction API error: Transaction already closed');
              }
              const key = `${model}.${method}`;
              mockQueries.push(`${label}:${key}:${args?.where?.id ?? ''}`);
              const answer = mockAnswers[`${kind}/${key}`];
              if (answer !== undefined) return answer;
              if (method === 'findMany' || method === 'groupBy') return [];
              if (method === 'count') return 0;
              if (method === 'deleteMany') return { count: 0 };
              if (isDefault && (method === 'findUnique' || method === 'findFirst')) return { id: kind };
              return null;
            };
          },
        }
      );
    },
  });
}

function mockMakeTransactionRunner(prefix: string, counter: () => number) {
  return jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const label = `${prefix}${counter()}`;
    let closed = false;
    const tx = mockMakeDb(label, () => closed);
    try {
      const result = await cb(tx);
      mockEvents.push(`commit:${label}`);
      return result;
    } catch (error) {
      mockEvents.push(`rollback:${label}`);
      throw error;
    } finally {
      closed = true;
    }
  });
}

jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({
  prisma: Object.assign(mockMakeDb('default', () => false), {
    $transaction: mockMakeTransactionRunner('tx', () => ++mockCoreTxCount),
  }),
}));
jest.mock('../../../src/core/prisma.content.service', () => ({
  prismaContent: Object.assign(mockMakeDb('content', () => false), {
    $transaction: mockMakeTransactionRunner('ctx', () => ++mockContentTxCount),
  }),
}));
jest.mock('../../../src/core/prisma.historical.service', () => ({
  prismaHistorical: { positioningSnapshot: { upsert: jest.fn() } },
}));
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: {
    invalidate: jest.fn(async () => {
      mockEvents.push('flush');
    }),
    invalidateByPattern: jest.fn(async () => {
      mockEvents.push('flush');
    }),
    getOrSet: jest.fn(async (_key: string, loader: () => Promise<unknown>) => loader()),
  },
}));
jest.mock('../../../src/services/xp/xp.service', () => ({
  xpService: {
    grantXp: jest.fn().mockResolvedValue(5),
    completeDailyTask: jest.fn().mockResolvedValue(undefined),
  },
}));
// The enrichment fan-out (creator, reviewer...) is not under test: rows pass through
jest.mock('../../../src/utils/cross-db-enrich', () => {
  const passThrough = jest.fn(async (rows: unknown) => rows);
  return {
    attachCreator: passThrough,
    attachReviewer: passThrough,
    attachAssigner: passThrough,
    attachReporter: passThrough,
    attachSubmitter: passThrough,
    attachReviewedBy: passThrough,
    attachCreatorOne: passThrough,
    attachSubmitterAndReviewerOne: passThrough,
  };
});

import { ReadListItemService } from '../../../src/services/readlist/readlist-item.service';
import { EducationalResourceService } from '../../../src/services/educational/educational-resource.service';
import { WalletService } from '../../../src/services/wallet/wallet.service';
import {
  readListItemRepository,
  readListRepository,
  educationalResourceRepository,
  educationalCategoryRepository,
} from '../../../src/repositories';
import { walletRepository } from '../../../src/repositories/wallet.repository';
import { userWalletRepository } from '../../../src/repositories/userWallet.repository';
import { scopedClient } from '../../../src/utils/tx-scope';
import { cacheService } from '../../../src/core/cache.service';
import { xpService } from '../../../src/services/xp/xp.service';
import {
  ReadListItemNotFoundError,
  ReadListNotFoundError,
  ReadListPermissionError,
  ReadListResourceNotFoundError,
} from '../../../src/errors/readlist.errors';
import {
  EducationalResourceNotFoundError,
  EducationalCategoryNotFoundError,
  EducationalResourceCategoryAlreadyExistsError,
  EducationalResourceCategoryNotFoundError,
} from '../../../src/errors/educational.errors';
import { WalletNotFoundError, UserNotFoundError } from '../../../src/errors/wallet.errors';

const universe: Record<string, object> = {
  readListItem: readListItemRepository,
  readList: readListRepository,
  educationalResource: educationalResourceRepository,
  educationalCategory: educationalCategoryRepository,
  wallet: walletRepository,
  userWallet: userWalletRepository,
};

/** The client each repository is bound to right now (null = none: it uses its own database). */
function bound(): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(universe).map(([name, repo]) => [name, scopedClient<{ label: string }>(repo)?.label ?? null])
  );
}

const noneBound = Object.fromEntries(Object.keys(universe).map((name) => [name, null]));
const onlyBound = (labels: Record<string, string>) => ({ ...noneBound, ...labels });

const spies: jest.SpyInstance[] = [];

/** Records which repositories are bound each time `method` of `repo` is called. */
function recordBindings(repo: object, method: string): Array<Record<string, string | null>> {
  const seen: Array<Record<string, string | null>> = [];
  const target = repo as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target[method].bind(repo);
  spies.push(
    jest.spyOn(target, method).mockImplementation((...args: unknown[]) => {
      seen.push(bound());
      return original(...args);
    })
  );
  return seen;
}

const answer = (key: string, value: unknown) => {
  mockAnswers[key] = value;
};
const flushes = () => mockEvents.filter((e) => e === 'flush').length;

beforeEach(() => {
  mockQueries.length = 0;
  mockEvents.length = 0;
  mockCoreTxCount = 0;
  mockContentTxCount = 0;
  for (const key of Object.keys(mockAnswers)) delete mockAnswers[key];
  jest.clearAllMocks();
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

/** After a body threw: nothing is bound, and reads go to the default clients. */
async function expectBackOnOwnClients() {
  expect(bound()).toEqual(noneBound);
  for (const key of Object.keys(mockAnswers)) delete mockAnswers[key]; // plain marker answers
  mockQueries.length = 0;
  await readListItemRepository.findById(1);
  await readListRepository.isOwner(5, 1);
  await educationalResourceRepository.isAssignedToCategory(1, 1);
  await userWalletRepository.findByUserAndWallet(1, 1);
  expect(mockQueries).toEqual([
    'default:readListItem.findUnique:1',
    'default:readList.findUnique:5',
    'content:educationalResourceCategory.findFirst:',
    'default:userWallet.findUnique:',
  ]);
}

describe('ReadListItemService', () => {
  const service = new ReadListItemService();

  describe('toggleReadStatus', () => {
    it('binds the item and read list repositories, and nothing else, for the body', async () => {
      answer('tx/readListItem.findUnique', { id: 1, readListId: 5, resourceId: 9, isRead: false });
      answer('tx/readList.findUnique', { id: 5, userId: 2 });
      const seen = recordBindings(readListRepository, 'isOwner');

      await expect(service.toggleReadStatus(1, 1, true)).rejects.toBeInstanceOf(ReadListPermissionError);

      expect(seen).toEqual([onlyBound({ readListItem: 'tx1', readList: 'tx1' })]);
    });

    it('leaves the repositories on their own client and flushes nothing when the permission check throws', async () => {
      answer('tx/readListItem.findUnique', { id: 1, readListId: 5, resourceId: 9, isRead: false });
      answer('tx/readList.findUnique', { id: 5, userId: 2 });

      await expect(service.toggleReadStatus(1, 1, true)).rejects.toBeInstanceOf(ReadListPermissionError);
      await expectBackOnOwnClients();

      expect(mockEvents).toEqual(['rollback:tx1']);
      expect(cacheService.invalidate).not.toHaveBeenCalled();
      expect(cacheService.invalidateByPattern).not.toHaveBeenCalled();
      expect(xpService.grantXp).not.toHaveBeenCalled();
    });

    it('leaves the repositories on their own client when the item does not exist', async () => {
      await expect(service.toggleReadStatus(1, 1, true)).rejects.toBeInstanceOf(ReadListItemNotFoundError);
      await expectBackOnOwnClients();
      expect(flushes()).toBe(0);
    });

    it('flushes the caches only after the commit', async () => {
      answer('tx/readListItem.findUnique', { id: 1, readListId: 5, resourceId: 9, isRead: false });
      answer('tx/readList.findUnique', { id: 5, userId: 1 });
      answer('tx/readListItem.update', { id: 1, readListId: 5, resourceId: 9, isRead: true });

      const result = await service.toggleReadStatus(1, 1, true);

      expect(result.xpGranted).toBe(5);
      expect(mockEvents[0]).toBe('commit:tx1');
      expect(flushes()).toBeGreaterThan(0);
      expect(mockQueries.filter((q) => q.startsWith('tx1:'))).toEqual([
        'tx1:readListItem.findUnique:1',
        'tx1:readList.findUnique:5',
        'tx1:readListItem.update:1',
      ]);
      await expectBackOnOwnClients();
    });
  });

  describe('reorderItems', () => {
    it('binds the item and read list repositories, and nothing else, for the body', async () => {
      answer('tx/readList.findUnique', { id: 5, userId: 2 });
      const seen = recordBindings(readListRepository, 'isOwner');

      await expect(service.reorderItems(5, 1, [{ id: 1, order: 0 }])).rejects.toBeInstanceOf(ReadListPermissionError);

      expect(seen).toEqual([onlyBound({ readListItem: 'tx1', readList: 'tx1' })]);
    });

    it('leaves the repositories on their own client and flushes nothing when the permission check throws', async () => {
      answer('tx/readList.findUnique', { id: 5, userId: 2 });

      await expect(service.reorderItems(5, 1, [{ id: 1, order: 0 }])).rejects.toBeInstanceOf(ReadListPermissionError);
      await expectBackOnOwnClients();

      expect(mockEvents).toEqual(['rollback:tx1']);
    });
  });

  describe('addResourceToReadList (no outer transaction)', () => {
    const input = { resourceId: 9, readListId: 5 };

    it('does its checks on the default clients and opens one transaction, the one of create', async () => {
      answer('content/educationalResource.findUnique', { id: 9, url: 'https://example.com' });
      answer('default/readList.findUnique', { id: 5, userId: 1 });
      answer('tx/readListItem.create', { id: 3, readListId: 5, resourceId: 9 });
      const seen = recordBindings(readListRepository, 'isOwner');

      await expect(service.addResourceToReadList(input, 1)).resolves.toMatchObject({ id: 3 });

      expect(mockCoreTxCount).toBe(1);
      expect(seen).toEqual([noneBound]);
      const before = mockQueries.slice(0, mockQueries.findIndex((q) => q.startsWith('tx1:')));
      expect(before.length).toBeGreaterThan(0);
      expect(before.every((q) => q.startsWith('default:') || q.startsWith('content:'))).toBe(true);
      expect(mockQueries.filter((q) => q.startsWith('tx1:'))).toEqual([
        'tx1:readListItem.findFirst:',
        'tx1:readListItem.create:',
      ]);
      // the summary flush runs after create's own commit
      expect(mockEvents[0]).toBe('commit:tx1');
      expect(flushes()).toBeGreaterThan(0);
      await expectBackOnOwnClients();
    });

    it('opens no transaction and flushes nothing when the caller does not own the list', async () => {
      answer('content/educationalResource.findUnique', { id: 9, url: 'https://example.com' });
      answer('default/readList.findUnique', { id: 5, userId: 2 });

      await expect(service.addResourceToReadList(input, 1)).rejects.toBeInstanceOf(ReadListPermissionError);

      expect(mockCoreTxCount).toBe(0);
      expect(mockEvents).toEqual([]);
      await expectBackOnOwnClients();
    });

    it('opens no transaction when the list or the resource does not exist', async () => {
      answer('content/educationalResource.findUnique', null);
      await expect(service.addResourceToReadList(input, 1)).rejects.toBeInstanceOf(ReadListResourceNotFoundError);

      answer('content/educationalResource.findUnique', { id: 9, url: 'https://example.com' });
      answer('default/readList.findUnique', null);
      await expect(service.addResourceToReadList(input, 1)).rejects.toBeInstanceOf(ReadListNotFoundError);

      expect(mockCoreTxCount).toBe(0);
      expect(mockEvents).toEqual([]);
    });
  });

  describe('deleteWithPermission (no outer transaction)', () => {
    it('does its checks on the default clients and opens one transaction, the one of delete', async () => {
      answer('default/readListItem.findUnique', { id: 1, readListId: 5, resourceId: 9 });
      answer('default/readList.findUnique', { id: 5, userId: 1 });
      answer('tx/readListItem.findUnique', { id: 1, readListId: 5, resourceId: 9 });
      const seen = recordBindings(readListRepository, 'isOwner');

      await expect(service.deleteWithPermission(1, 1)).resolves.toBeUndefined();

      expect(mockCoreTxCount).toBe(1);
      expect(seen).toEqual([noneBound]);
      expect(mockQueries.filter((q) => q.startsWith('tx1:'))).toEqual([
        'tx1:readListItem.findUnique:1',
        'tx1:readListItem.delete:1',
      ]);
      expect(mockEvents[0]).toBe('commit:tx1');
      expect(flushes()).toBeGreaterThan(0);
      await expectBackOnOwnClients();
    });

    it('opens no transaction and flushes nothing when the caller does not own the list or the item is gone', async () => {
      answer('default/readListItem.findUnique', { id: 1, readListId: 5, resourceId: 9 });
      answer('default/readList.findUnique', { id: 5, userId: 2 });
      await expect(service.deleteWithPermission(1, 1)).rejects.toBeInstanceOf(ReadListPermissionError);

      answer('default/readListItem.findUnique', null);
      await expect(service.deleteWithPermission(1, 1)).rejects.toBeInstanceOf(ReadListItemNotFoundError);

      expect(mockCoreTxCount).toBe(0);
      expect(mockEvents).toEqual([]);
    });
  });
});

describe('EducationalResourceService', () => {
  const service = new EducationalResourceService();
  const assignment = { resourceId: 1, categoryId: 2, assignedBy: 3 };

  describe('assignToCategory', () => {
    it('binds the resource and category repositories, and nothing else, for the body', async () => {
      answer('ctx/educationalResource.findUnique', { id: 1 });
      const seen = recordBindings(educationalCategoryRepository, 'findById');

      await expect(service.assignToCategory(assignment)).rejects.toBeInstanceOf(EducationalCategoryNotFoundError);

      expect(seen).toEqual([onlyBound({ educationalResource: 'ctx1', educationalCategory: 'ctx1' })]);
    });

    it('leaves the repositories on their own client and flushes nothing when the resource is not found', async () => {
      await expect(service.assignToCategory(assignment)).rejects.toBeInstanceOf(EducationalResourceNotFoundError);

      await expectBackOnOwnClients();
      expect(mockEvents).toEqual(['rollback:ctx1']);
    });

    it('leaves the repositories on their own client and flushes nothing when the assignment already exists', async () => {
      answer('ctx/educationalResource.findUnique', { id: 1 });
      answer('ctx/educationalCategory.findUnique', { id: 2 });
      answer('ctx/educationalResourceCategory.findFirst', { id: 7 });

      await expect(service.assignToCategory(assignment)).rejects.toBeInstanceOf(
        EducationalResourceCategoryAlreadyExistsError
      );

      await expectBackOnOwnClients();
      expect(mockEvents).toEqual(['rollback:ctx1']);
    });

    it('flushes the caches only after the commit', async () => {
      answer('ctx/educationalResource.findUnique', { id: 1 });
      answer('ctx/educationalCategory.findUnique', { id: 2 });
      answer('ctx/educationalResourceCategory.create', { id: 8, resourceId: 1, categoryId: 2 });

      await expect(service.assignToCategory(assignment)).resolves.toMatchObject({ id: 8 });

      expect(mockEvents[0]).toBe('commit:ctx1');
      expect(flushes()).toBeGreaterThan(0);
      await expectBackOnOwnClients();
    });
  });

  describe('removeFromCategory', () => {
    it('binds the resource repository only for the body', async () => {
      answer('ctx/educationalResource.findUnique', { id: 1 });
      const seen = recordBindings(educationalResourceRepository, 'isAssignedToCategory');

      await expect(service.removeFromCategory(1, 2)).rejects.toBeInstanceOf(EducationalResourceCategoryNotFoundError);

      expect(seen).toEqual([onlyBound({ educationalResource: 'ctx1' })]);
    });

    it('leaves the repositories on their own client and flushes nothing when the resource is not found', async () => {
      await expect(service.removeFromCategory(1, 2)).rejects.toBeInstanceOf(EducationalResourceNotFoundError);

      await expectBackOnOwnClients();
      expect(mockEvents).toEqual(['rollback:ctx1']);
    });

    it('flushes the caches only after the commit', async () => {
      answer('ctx/educationalResource.findUnique', { id: 1 });
      answer('ctx/educationalResourceCategory.findFirst', { id: 7 });

      await expect(service.removeFromCategory(1, 2)).resolves.toBeUndefined();

      expect(mockEvents[0]).toBe('commit:ctx1');
      expect(flushes()).toBeGreaterThan(0);
      await expectBackOnOwnClients();
    });
  });
});

describe('WalletService', () => {
  const service = new WalletService();

  describe('removeWalletFromUser', () => {
    it('binds the wallet and user wallet repositories, and nothing else, for the body', async () => {
      const seen = recordBindings(userWalletRepository, 'findByUserAndWallet');

      await expect(service.removeWalletFromUser(5, 1)).rejects.toBeInstanceOf(WalletNotFoundError);

      expect(seen).toEqual([onlyBound({ wallet: 'tx1', userWallet: 'tx1' })]);
    });

    it('leaves the repositories on their own client and flushes nothing when the link is not found', async () => {
      await expect(service.removeWalletFromUser(5, 1)).rejects.toBeInstanceOf(WalletNotFoundError);

      await expectBackOnOwnClients();
      expect(mockEvents).toEqual(['rollback:tx1']);
    });

    it('flushes the cache only after the commit', async () => {
      answer('tx/userWallet.findUnique', { id: 4 });

      await expect(service.removeWalletFromUser(5, 1)).resolves.toBeUndefined();

      expect(mockQueries).toContain('tx1:userWallet.delete:4');
      expect(mockEvents).toEqual(['commit:tx1', 'flush']);
      await expectBackOnOwnClients();
    });
  });

  describe('updateWalletName', () => {
    it('leaves the repositories on their own client and flushes nothing when the link is not found', async () => {
      await expect(service.updateWalletName(1, 5, 'Main')).rejects.toBeInstanceOf(WalletNotFoundError);

      await expectBackOnOwnClients();
      expect(mockEvents).toEqual(['rollback:tx1']);
    });

    it('flushes the cache only after the commit', async () => {
      answer('tx/userWallet.findUnique', { id: 4 });
      answer('tx/userWallet.update', { id: 4, name: 'Main' });

      await expect(service.updateWalletName(1, 5, 'Main')).resolves.toMatchObject({ name: 'Main' });

      expect(mockEvents).toEqual(['commit:tx1', 'flush']);
      await expectBackOnOwnClients();
    });
  });

  describe('bulkDeleteWallets', () => {
    it('binds the wallet and user wallet repositories, and nothing else, for the body', async () => {
      answer('tx/user.findUnique', { id: 1 });
      const seen = recordBindings(userWalletRepository, 'findManyByUserAndWallets');

      await service.bulkDeleteWallets('privy-1', [5]);

      expect(seen).toEqual([onlyBound({ wallet: 'tx1', userWallet: 'tx1' })]);
    });

    it('leaves the repositories on their own client and flushes nothing when the user is not found', async () => {
      await expect(service.bulkDeleteWallets('privy-1', [5])).rejects.toBeInstanceOf(UserNotFoundError);

      await expectBackOnOwnClients();
      expect(mockEvents).toEqual(['rollback:tx1']);
    });

    it('flushes the cache only after the commit', async () => {
      answer('tx/user.findUnique', { id: 1 });
      answer('tx/userWallet.findMany', [{ walletId: 5 }]);
      answer('tx/userWallet.deleteMany', { count: 1 });

      await expect(service.bulkDeleteWallets('privy-1', [5])).resolves.toMatchObject({ deleted: 1, failed: 0 });

      expect(mockEvents).toEqual(['commit:tx1', 'flush']);
      await expectBackOnOwnClients();
    });
  });
});
