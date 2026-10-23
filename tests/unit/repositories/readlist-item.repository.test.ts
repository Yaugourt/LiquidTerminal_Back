/**
 * ReadListItem lives in the Core DB, the resource in the Content DB: the Core schema
 * has no relation to it, so writes must send scalar ids (no nested `connect`).
 */
const mockCreate = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({
  prisma: { readListItem: { create: mockCreate, deleteMany: mockDeleteMany } },
}));
jest.mock('../../../src/core/prisma.content.service', () => ({
  prismaContent: {
    educationalResource: {
      findMany: jest.fn().mockResolvedValue([
        { id: 500, url: 'https://example.com/a', createdAt: new Date(0), addedBy: 3, linkPreview: null },
      ]),
    },
  },
}));
jest.mock('../../../src/utils/cross-db-enrich', () => ({
  attachCreator: jest.fn(async (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => ({ ...r, creator: { id: 3, name: 'alice', email: null } }))
  ),
}));

import { PrismaReadListItemRepository } from '../../../src/repositories/prisma/prisma.readlist-item.repository';

describe('PrismaReadListItemRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  it('create sends scalar ids and no relation connect', async () => {
    mockCreate.mockResolvedValue({ id: 1, readListId: 10, resourceId: 500, notes: 'n', order: 2 });

    const item = await new PrismaReadListItemRepository().create({
      readListId: 10,
      resourceId: 500,
      notes: 'n',
      order: 2,
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: { readListId: 10, resourceId: 500, notes: 'n', order: 2 },
    });
    const data = mockCreate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('resource');
    expect(data).not.toHaveProperty('readList');
    // response shape the frontend receives is unchanged
    expect(item).toMatchObject({
      id: 1,
      resourceId: 500,
      resource: { id: 500, url: 'https://example.com/a', creator: { id: 3, name: 'alice' } },
    });
  });

  it('create refuses a missing readListId', async () => {
    await expect(new PrismaReadListItemRepository().create({ resourceId: 500 })).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('deleteByResourceId deletes by resourceId and returns the count', async () => {
    mockDeleteMany.mockResolvedValue({ count: 3 });

    await expect(new PrismaReadListItemRepository().deleteByResourceId(500)).resolves.toBe(3);
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { resourceId: 500 } });
  });

  it('deleteByResourceId ignores a transaction client swapped in by another request', async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });
    const txDeleteMany = jest.fn();
    const repo = new PrismaReadListItemRepository();
    // ReadListItemService swaps the shared singleton's live client while its own tx runs
    repo.setPrismaClient({ readListItem: { deleteMany: txDeleteMany } } as never);

    await expect(repo.deleteByResourceId(500)).resolves.toBe(1);
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { resourceId: 500 } });
    expect(txDeleteMany).not.toHaveBeenCalled();
  });
});
