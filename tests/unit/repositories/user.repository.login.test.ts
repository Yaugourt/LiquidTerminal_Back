/**
 * Login with a social handle that is another account's name (User.name is unique):
 * the login succeeds instead of failing on P2002.
 */
import { Prisma } from '@prisma/client';

const mockUser = { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn() };

jest.mock('../../../src/core/prisma.service', () => ({ prisma: { user: mockUser } }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { UserRepositoryImpl } from '../../../src/repositories/user.repository';

const repo = new UserRepositoryImpl();
const nameConflict = () =>
  new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test', meta: { target: ['name'] } });

beforeEach(() => jest.resetAllMocks());

describe('findOrCreate with a taken name', () => {
  it('creates a new account under a free variant of the handle', async () => {
    mockUser.upsert.mockRejectedValueOnce(nameConflict()).mockResolvedValueOnce({ id: 9, name: 'alice-abc123' });
    mockUser.findUnique.mockResolvedValue(null);

    const user = await repo.findOrCreate('did:privy:xyzABC123', { name: 'alice' });

    expect(user.id).toBe(9);
    expect(mockUser.upsert).toHaveBeenCalledTimes(2);
    expect(mockUser.upsert.mock.calls[1][0].create.name).toBe('alice-abc123');
    expect(mockUser.upsert.mock.calls[1][0].update.name).toBe('alice-abc123');
  });

  it('keeps the name of an existing account whose new handle is taken', async () => {
    mockUser.upsert.mockRejectedValueOnce(nameConflict());
    mockUser.findUnique.mockResolvedValue({ id: 3, name: 'old-name' });
    mockUser.update.mockResolvedValue({ id: 3, name: 'old-name' });

    const user = await repo.findOrCreate('did:privy:xyz', { name: 'alice' });

    expect(user.name).toBe('old-name');
    expect(mockUser.update.mock.calls[0][0].data).not.toHaveProperty('name');
  });

  it('retries with a longer variant when the first one is also taken', async () => {
    mockUser.upsert
      .mockRejectedValueOnce(nameConflict())
      .mockRejectedValueOnce(nameConflict())
      .mockResolvedValueOnce({ id: 9 });
    mockUser.findUnique.mockResolvedValue(null);

    await repo.findOrCreate('did:privy:xyzABC123456789', { name: 'alice' });

    expect(mockUser.upsert.mock.calls[2][0].create.name).toBe('alice-c123456789');
  });

  it('does not swallow other errors', async () => {
    mockUser.upsert.mockRejectedValue(new Error('db down'));
    await expect(repo.findOrCreate('did:privy:x', { name: 'alice' })).rejects.toThrow('db down');
  });

  it('does not treat a conflict on another column as a name conflict', async () => {
    mockUser.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test', meta: { target: ['email'] } }),
    );
    await expect(repo.findOrCreate('did:privy:x', { name: 'alice' })).rejects.toThrow('dup');
    expect(mockUser.upsert).toHaveBeenCalledTimes(1);
  });
});
