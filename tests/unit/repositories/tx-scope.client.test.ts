/**
 * Every repository resolves its client per access: the transaction it is bound to
 * in the current async context (runWithTx), else its own database. Nothing is
 * stored on the singleton, so a binding never outlives its scope or leaks to
 * another flow.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: { db: 'core' } }));
jest.mock('../../../src/core/prisma.content.service', () => ({ prismaContent: { db: 'content' } }));
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: { db: 'historical' } }));

import { PrismaReadListRepository } from '../../../src/repositories/prisma/prisma.readlist.repository';
import { PrismaCategoryRepository } from '../../../src/repositories/prisma/prisma.category.repository';
import { PrismaHistoricalLiquidationRepository } from '../../../src/repositories/prisma/prisma.historical.repository';
import { WalletRepository } from '../../../src/repositories/wallet.repository';
import { UserWalletRepository } from '../../../src/repositories/userWallet.repository';
import { UserRepositoryImpl } from '../../../src/repositories/user.repository';
import { runWithTx } from '../../../src/utils/tx-scope';

// The client getter is protected/private on purpose: read it the way the repository's own methods do.
const clientOf = (repo: object): unknown => (repo as { prismaClient: unknown }).prismaClient;

const tx = { db: 'tx' };

describe.each([
  ['Core repository', () => new PrismaReadListRepository(), { db: 'core' }],
  ['Content repository', () => new PrismaCategoryRepository(), { db: 'content' }],
  ['historical repository', () => new PrismaHistoricalLiquidationRepository(), { db: 'historical' }],
  ['standalone wallet repository', () => new WalletRepository(), { db: 'core' }],
  ['standalone user-wallet repository', () => new UserWalletRepository(), { db: 'core' }],
  ['standalone user repository', () => new UserRepositoryImpl(), { db: 'core' }],
])('%s', (_name, make, defaultClient) => {
  it('uses its own database outside a scope', () => {
    expect(clientOf(make())).toEqual(defaultClient);
  });

  it('uses the bound transaction inside a scope, whatever its database, then its own database again', async () => {
    const repo = make();

    await runWithTx(tx, [repo], async () => {
      await Promise.resolve();
      expect(clientOf(repo)).toBe(tx);
    });

    expect(clientOf(repo)).toEqual(defaultClient);
  });

  it('is back on its own database after a scope that threw', async () => {
    const repo = make();

    await expect(
      runWithTx(tx, [repo], async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(clientOf(repo)).toEqual(defaultClient);
  });

  it('stays on its own database when the scope binds another instance', async () => {
    const repo = make();

    await runWithTx(tx, [make()], async () => {
      expect(clientOf(repo)).toEqual(defaultClient);
    });
  });
});
