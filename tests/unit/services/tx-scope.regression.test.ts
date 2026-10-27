/**
 * A service that runs a block in a transaction used to swap the transaction client
 * onto its singleton repository and back. A throw before the swap back (409, not
 * found, a Prisma error), or WalletService.addWallet which never swapped back, left
 * the repository on a closed transaction for every later request (P2028), and two
 * concurrent requests shared the swapped client. The transaction is now bound to the
 * repository for the duration of the block only (runWithTx).
 *
 * The fake clients below throw like Prisma when a transaction client is used after
 * its block ended, and record which client served each query.
 */
import { z } from 'zod';

type Model = Record<string, jest.Mock>;
type FakeClient = { label: string } & Record<string, unknown>;

const mockQueries: string[] = [];
// Canned answers of the fake transaction clients, by 'model.method'
const mockTxAnswers: Record<string, unknown> = {};
let mockTxCount = 0;

function mockMakeTx(): { tx: FakeClient; close: () => void } {
  const label = `tx${++mockTxCount}`;
  let closed = false;
  const method = (name: string) =>
    jest.fn(async (args?: { where?: { id?: number } }) => {
      if (closed) {
        throw new Error('P2028 Transaction API error: Transaction already closed');
      }
      mockQueries.push(`${label}:${name}:${args?.where?.id ?? ''}`);
      return mockTxAnswers[name] ?? null;
    });
  const model = (m: string, methods: string[]): Model =>
    Object.fromEntries(methods.map((x) => [x, method(`${m}.${x}`)]));
  return {
    tx: {
      label,
      thing: model('thing', ['findUnique', 'create', 'update']),
      user: model('user', ['findUnique']),
      wallet: model('wallet', ['findUnique', 'create']),
      userWallet: model('userWallet', ['findUnique', 'create']),
    },
    close: () => {
      closed = true;
    },
  };
}

// The default (non transactional) client: answers with a marker no transaction produces
const mockDefaultClient = (() => {
  const method = (name: string) =>
    jest.fn(async (args?: { where?: { id?: number } }) => {
      mockQueries.push(`default:${name}:${args?.where?.id ?? ''}`);
      return { id: 'default' };
    });
  return {
    thing: { findUnique: method('thing.findUnique') },
    wallet: { findUnique: method('wallet.findUnique') },
    userWallet: { findUnique: method('userWallet.findUnique') },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const { tx, close } = mockMakeTx();
      try {
        return await cb(tx);
      } finally {
        close();
      }
    }),
  };
})();

jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getClient: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/prisma.service', () => ({ prisma: mockDefaultClient }));
jest.mock('../../../src/core/cache.service', () => ({
  cacheService: {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateByPattern: jest.fn().mockResolvedValue(undefined),
    getOrSet: jest.fn(async (_key: string, loader: () => Promise<unknown>) => loader()),
  },
}));

import { BaseService, AnyPrismaClient } from '../../../src/core/crudBase.service';
import { BasePrismaRepository } from '../../../src/repositories/prisma/base-prisma.repository';
import { WalletService } from '../../../src/services/wallet/wallet.service';
import { walletRepository } from '../../../src/repositories/wallet.repository';
import { userWalletRepository } from '../../../src/repositories/userWallet.repository';
import { WalletAlreadyExistsError } from '../../../src/errors/wallet.errors';

// --- a minimal CRUD service over a real BasePrismaRepository ---

class ThingAlreadyExistsError extends Error {}
class ThingNotFoundError extends Error {}
class ThingValidationError extends Error {}

class ThingRepository extends BasePrismaRepository {
  private get db(): Record<string, Model> {
    return this.prismaClient as unknown as Record<string, Model>;
  }
  async findById(id: number) {
    return this.db.thing.findUnique({ where: { id } });
  }
  async create(data: { name: string }) {
    return this.db.thing.create({ data });
  }
  async update(id: number, data: { name: string }) {
    return this.db.thing.update({ where: { id }, data });
  }
}

const thingRepository = new ThingRepository();
// Per id: what checkExistsForUpdate waits for (lets a test hold a request inside its transaction)
const gates = new Map<number, Promise<void>>();
let thingExists = false;

class ThingService extends BaseService<{ id: number }, { name: string }, { name: string }, { page?: number }> {
  protected repository = thingRepository;
  protected transactionClient = mockDefaultClient as unknown as AnyPrismaClient;
  protected cacheKeyPrefix = 'thing';
  protected validationSchemas = {
    create: z.object({ name: z.string() }),
    update: z.object({ name: z.string() }),
    query: z.object({ page: z.number().optional() }),
  };
  protected errorClasses = {
    notFound: ThingNotFoundError,
    alreadyExists: ThingAlreadyExistsError,
    validation: ThingValidationError,
  };
  protected async checkExists(): Promise<boolean> {
    return thingExists;
  }
  protected async checkExistsForUpdate(id: number): Promise<boolean> {
    await gates.get(id);
    return false;
  }
  protected async checkCanDelete(): Promise<void> {}
}

const ADDRESS = `0x${'a'.repeat(40)}`;

beforeEach(() => {
  mockQueries.length = 0;
  mockTxCount = 0;
  for (const key of Object.keys(mockTxAnswers)) delete mockTxAnswers[key];
  gates.clear();
  thingExists = false;
});

describe('BaseService create/update/delete', () => {
  it('leaves the repository on its own client after an alreadyExists thrown inside the transaction', async () => {
    thingExists = true;

    await expect(new ThingService().create({ name: 'a' })).rejects.toBeInstanceOf(ThingAlreadyExistsError);
    await expect(thingRepository.findById(1)).resolves.toEqual({ id: 'default' });

    expect(mockQueries).toEqual(['default:thing.findUnique:1']);
  });

  it('leaves the repository on its own client after a notFound thrown inside the transaction', async () => {
    // thing.findUnique answers null on the transaction: update throws notFound
    await expect(new ThingService().update(1, { name: 'a' })).rejects.toBeInstanceOf(ThingNotFoundError);
    await expect(thingRepository.findById(1)).resolves.toEqual({ id: 'default' });
  });

  it('leaves the repository on its own client after a Prisma error inside the transaction', async () => {
    mockDefaultClient.$transaction.mockImplementationOnce(async (cb) => {
      const { tx, close } = mockMakeTx();
      try {
        (tx.thing as Model).create.mockRejectedValueOnce(new Error('P2002 unique constraint'));
        return await cb(tx);
      } finally {
        close();
      }
    });

    await expect(new ThingService().create({ name: 'a' })).rejects.toThrow('P2002');
    await expect(thingRepository.findById(1)).resolves.toEqual({ id: 'default' });
  });

  it('leaves the repository on its own client after a successful create', async () => {
    mockTxAnswers['thing.create'] = { id: 7 };

    await expect(new ThingService().create({ name: 'a' })).resolves.toEqual({ id: 7 });
    await expect(thingRepository.findById(7)).resolves.toEqual({ id: 'default' });
  });

  it('serves a read made during another request\'s transaction from its own client, not from that transaction', async () => {
    let release!: () => void;
    gates.set(1, new Promise<void>((resolve) => (release = resolve)));
    mockTxAnswers['thing.findUnique'] = { id: 1 };
    mockTxAnswers['thing.update'] = { id: 1 };

    const update = new ThingService().update(1, { name: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 5)); // update is now held inside its transaction

    // another request reads through the same singleton meanwhile
    await expect(thingRepository.findById(2)).resolves.toEqual({ id: 'default' });
    expect(mockQueries).toContain('default:thing.findUnique:2');

    release();
    await update;
  });

  it('keeps each of two overlapping requests on its own transaction until it ends', async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    gates.set(1, new Promise<void>((resolve) => (releaseA = resolve)));
    gates.set(2, new Promise<void>((resolve) => (releaseB = resolve)));
    mockTxAnswers['thing.findUnique'] = { id: 1 };
    mockTxAnswers['thing.update'] = { id: 1 };

    const service = new ThingService();
    const a = service.update(1, { name: 'a' });
    const b = service.update(2, { name: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 5)); // both held inside their transactions

    // A ends first: it used to move B's remaining steps back to the default client
    releaseA();
    await a;
    releaseB();
    await b;

    const of = (id: number) => mockQueries.filter((q) => q.endsWith(`:${id}`));
    expect(of(1)).toEqual(['tx1:thing.findUnique:1', 'tx1:thing.update:1']);
    expect(of(2)).toEqual(['tx2:thing.findUnique:2', 'tx2:thing.update:2']);
  });
});

describe('WalletService.addWallet', () => {
  it('leaves both repositories on their own client after a successful add', async () => {
    mockTxAnswers['user.findUnique'] = { id: 1 };
    mockTxAnswers['wallet.create'] = { id: 5, address: ADDRESS };
    mockTxAnswers['userWallet.create'] = { id: 9, userId: 1, walletId: 5 };

    await expect(new WalletService().addWallet('privy-1', ADDRESS)).resolves.toMatchObject({ walletId: 5 });
    // the wallet-list copy path reads the link through this repository next
    await expect(userWalletRepository.findByUserAndWallet(1, 5)).resolves.toEqual({ id: 'default' });
    await expect(walletRepository.findByAddress(ADDRESS)).resolves.toEqual({ id: 'default' });

    expect(mockQueries.filter((q) => q.startsWith('default:'))).toHaveLength(2);
  });

  it('uses the transaction for the repositories during the add', async () => {
    mockTxAnswers['user.findUnique'] = { id: 1 };
    mockTxAnswers['wallet.create'] = { id: 5, address: ADDRESS };
    mockTxAnswers['userWallet.create'] = { id: 9, userId: 1, walletId: 5 };

    await new WalletService().addWallet('privy-1', ADDRESS);

    expect(mockQueries).toEqual(
      expect.arrayContaining(['tx1:wallet.findUnique:', 'tx1:wallet.create:', 'tx1:userWallet.create:'])
    );
    expect(mockQueries.some((q) => q.startsWith('default:'))).toBe(false);
  });

  it('leaves both repositories on their own client after a WalletAlreadyExistsError', async () => {
    mockTxAnswers['user.findUnique'] = { id: 1 };
    mockTxAnswers['wallet.findUnique'] = { id: 5, address: ADDRESS };
    mockTxAnswers['userWallet.findUnique'] = { id: 9 };

    await expect(new WalletService().addWallet('privy-1', ADDRESS)).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    await expect(userWalletRepository.findByUserAndWallet(1, 5)).resolves.toEqual({ id: 'default' });
    await expect(walletRepository.findByAddress(ADDRESS)).resolves.toEqual({ id: 'default' });
  });
});
