/**
 * The XP a create/copy/add answers with is what grantXp actually credited:
 * 0 when the daily/weekly cap refused it or the grant threw, never a constant.
 */
const mockGrantXp = jest.fn();

jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: { readListItem: { createMany: jest.fn() } } }));
jest.mock('../../../src/repositories', () => ({ readListRepository: {} }));
jest.mock('../../../src/core/cache.service', () => ({ cacheService: {} }));
jest.mock('../../../src/services/xp/xp.service', () => ({ xpService: { grantXp: mockGrantXp } }));

import { BaseService } from '../../../src/core/crudBase.service';
import { ReadListService } from '../../../src/services/readlist/readlist.service';
import { WalletListService } from '../../../src/services/walletlist/walletlist.service';
import type { XpTally } from '../../../src/types/xp.types';

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(BaseService.prototype, 'create').mockResolvedValue({ id: 5 } as never);
});

function readListService() {
  const s = new ReadListService() as unknown as Record<string, unknown>;
  s.invalidateReadListCache = jest.fn();
  return s as unknown as ReadListService;
}
function walletListService() {
  const s = new WalletListService() as unknown as Record<string, unknown>;
  s.invalidateWalletListCache = jest.fn();
  return s as unknown as WalletListService;
}

describe('readlist create', () => {
  const data = { name: 'n', userId: 1, isPublic: true };

  it('reports 0 when the cap refused the grants', async () => {
    mockGrantXp.mockResolvedValue(0);
    const xp: XpTally = { granted: 0 };
    await readListService().create(data as never, xp);
    expect(xp.granted).toBe(0);
  });

  it('sums the creation reward and the public bonus actually granted', async () => {
    mockGrantXp.mockResolvedValueOnce(15).mockResolvedValueOnce(5);
    const xp: XpTally = { granted: 0 };
    await readListService().create(data as never, xp);
    expect(xp.granted).toBe(20);
  });

  it('keeps what was granted before a later grant throws, and does not throw', async () => {
    mockGrantXp.mockResolvedValueOnce(15).mockRejectedValueOnce(new Error('db'));
    const xp: XpTally = { granted: 0 };
    await expect(readListService().create(data as never, xp)).resolves.toBeDefined();
    expect(xp.granted).toBe(15);
  });
});

describe('walletlist create', () => {
  it('reports 0 when the grant is capped and the amount granted otherwise', async () => {
    const data = { name: 'n', userId: 1, isPublic: false };
    mockGrantXp.mockResolvedValue(0);
    const capped: XpTally = { granted: 0 };
    await walletListService().create(data as never, capped);
    expect(capped.granted).toBe(0);

    mockGrantXp.mockResolvedValue(10);
    const ok: XpTally = { granted: 0 };
    await walletListService().create(data as never, ok);
    expect(ok.granted).toBe(10);
  });
});

describe('readlist copy', () => {
  it('reports creation + copy XP as granted, 0 when both were capped', async () => {
    const original = { id: 1, name: 'R', description: null, isPublic: true, creator: { id: 1, name: 'o' }, items: [] };
    const make = (created: number) => {
      const stub = {
        repository: { findById: jest.fn().mockResolvedValueOnce(original).mockResolvedValue({ id: 2, items: [] }) },
        create: jest.fn(async (_d: unknown, xp?: XpTally) => { if (xp) xp.granted += created; return { id: 2 }; }),
        firstFreeCopyName: jest.fn().mockResolvedValue('R (Copy)'),
      };
      return stub;
    };
    mockGrantXp.mockResolvedValue(5);
    const a: XpTally = { granted: 0 };
    await ReadListService.prototype.copyReadList.call(make(15), 1, 99, a);
    expect(a.granted).toBe(20);

    mockGrantXp.mockResolvedValue(0);
    const b: XpTally = { granted: 0 };
    await ReadListService.prototype.copyReadList.call(make(0), 1, 99, b);
    expect(b.granted).toBe(0);
  });
});
