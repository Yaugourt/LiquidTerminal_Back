/**
 * PUT /publicgoods/:id spreads req.body into the update. The repository must
 * write the submitter's own columns only, so an owner cannot approve their
 * entry or rewrite its moderation fields.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: {} }));
jest.mock('../../../src/core/prisma.content.service', () => ({
  prismaContent: {
    publicGood: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data })),
    },
  },
}));
jest.mock('../../../src/utils/cross-db-enrich', () => ({
  attachSubmitter: jest.fn(async (rows: unknown) => rows),
  attachReviewedBy: jest.fn(async (rows: unknown) => rows),
  attachSubmitterAndReviewerOne: jest.fn(async (row: unknown) => row),
}));

import { prismaContent } from '../../../src/core/prisma.content.service';
import { PrismaPublicGoodRepository } from '../../../src/repositories/prisma/prisma.publicgood.repository';
import { PublicGoodCreateInput, PublicGoodUpdateInput } from '../../../src/types/publicgood.types';

const publicGood = (prismaContent as unknown as {
  publicGood: { create: jest.Mock; update: jest.Mock };
}).publicGood;

const moderationFields = {
  status: 'APPROVED',
  reviewerId: 99,
  reviewedAt: new Date('2026-10-22T00:00:00Z'),
  reviewNotes: 'looks good',
  submitterId: 42,
  submittedAt: new Date('2020-01-01T00:00:00Z'),
  id: 7,
};

describe('public good writes', () => {
  const repository = new PrismaPublicGoodRepository();

  beforeEach(() => jest.clearAllMocks());

  it('update writes the submitter fields only', async () => {
    await repository.update(1, {
      name: 'Liquid',
      technologies: ['ts'],
      ...moderationFields,
    } as unknown as PublicGoodUpdateInput);

    expect(publicGood.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: 'Liquid', technologies: ['ts'] },
    });
  });

  it('create forces PENDING and the authenticated submitter', async () => {
    await repository.create({
      name: 'Liquid',
      ...moderationFields,
      submitterId: 5,
    } as unknown as PublicGoodCreateInput);

    expect(publicGood.create).toHaveBeenCalledWith({
      data: { name: 'Liquid', submitterId: 5, status: 'PENDING' },
    });
  });
});
