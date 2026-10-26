/**
 * GET /wallet/:id — the ids are sequential, so the row is only readable by a
 * user who tracks it. The real auth middleware and WalletService run; the
 * token check and the database are mocked. An unknown id and a wallet someone
 * else tracks answer the same 404.
 */
import express from 'express';
import request from 'supertest';

const mockVerifyToken = jest.fn();
const mockUserFind = jest.fn();
const mockUserWalletFind = jest.fn();
const pass = (_req: unknown, _res: unknown, next: () => void) => next();

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/middleware/apiRateLimiter', () => ({ marketRateLimiter: pass }));
jest.mock('../../../src/services/auth/auth.service', () => ({
  AuthService: { getInstance: () => ({ verifyToken: (...args: unknown[]) => mockVerifyToken(...args) }) },
}));
jest.mock('../../../src/core/prisma.service', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => mockUserFind(...args) },
    userWallet: { findUnique: (...args: unknown[]) => mockUserWalletFind(...args) },
  },
}));
jest.mock('../../../src/core/transaction.service', () => ({ transactionService: {} }));
jest.mock('../../../src/core/cache.service', () => ({ cacheService: {} }));
jest.mock('../../../src/repositories/wallet.repository', () => ({ walletRepository: {} }));
jest.mock('../../../src/repositories/userWallet.repository', () => ({ userWalletRepository: {} }));
jest.mock('../../../src/services/walletlist/walletlist.service', () => ({ WalletListService: jest.fn() }));
jest.mock('../../../src/services/walletlist/walletlist-item.service', () => ({ WalletListItemService: jest.fn() }));

import walletRoutes from '../../../src/routes/wallet/wallet.routes';

const app = express();
app.use('/wallet', walletRoutes);

const WALLET = { id: 42, address: '0x' + 'a'.repeat(40), addedAt: '2026-10-01T00:00:00.000Z' };
const bearer = { Authorization: 'Bearer valid-token' };

describe('GET /wallet/:id', () => {
  beforeEach(() => {
    mockVerifyToken.mockReset().mockResolvedValue({ sub: 'did:privy:abc' });
    mockUserFind.mockReset().mockResolvedValue({ id: 7, privyUserId: 'did:privy:abc' });
    mockUserWalletFind.mockReset();
  });

  it('answers 401 without a token and reads nothing', async () => {
    const res = await request(app).get('/wallet/42');

    expect(res.status).toBe(401);
    expect(mockUserWalletFind).not.toHaveBeenCalled();
  });

  it('answers 404 for a wallet the user does not track', async () => {
    mockUserWalletFind.mockResolvedValue(null);

    const res = await request(app).get('/wallet/42').set(bearer);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'WALLET_NOT_FOUND' });
    expect(mockUserWalletFind).toHaveBeenCalledWith({
      where: { userId_walletId: { userId: 7, walletId: 42 } },
      include: { Wallet: true },
    });
  });

  it('answers the row for a wallet the user tracks', async () => {
    mockUserWalletFind.mockResolvedValue({ id: 1, userId: 7, walletId: 42, Wallet: WALLET });

    const res = await request(app).get('/wallet/42').set(bearer);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: WALLET });
  });

  it('checks the link on every call, not a copy shared between users', async () => {
    mockUserWalletFind.mockResolvedValueOnce({ id: 1, userId: 7, walletId: 42, Wallet: WALLET });
    mockUserWalletFind.mockResolvedValueOnce(null);

    expect((await request(app).get('/wallet/42').set(bearer)).status).toBe(200);
    expect((await request(app).get('/wallet/42').set(bearer)).status).toBe(404);
    expect(mockUserWalletFind).toHaveBeenCalledTimes(2);
  });

  it('answers 400 for an id that is not a number', async () => {
    const res = await request(app).get('/wallet/abc').set(bearer);

    expect(res.status).toBe(400);
    expect(mockUserWalletFind).not.toHaveBeenCalled();
  });
});
