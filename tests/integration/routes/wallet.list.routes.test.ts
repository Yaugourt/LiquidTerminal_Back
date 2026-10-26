/**
 * GET /wallet/ pages through every address any user tracks, so only an admin
 * may list it. The real auth and role middlewares run; the token check, the
 * database and the wallet read are mocked.
 */
import express from 'express';
import request from 'supertest';
import { WalletService } from '../../../src/services/wallet/wallet.service';

const mockVerifyToken = jest.fn();
const mockUserFind = jest.fn();
const pass = (_req: unknown, _res: unknown, next: () => void) => next();

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/middleware/apiRateLimiter', () => ({ marketRateLimiter: pass }));
jest.mock('../../../src/services/auth/auth.service', () => ({
  AuthService: { getInstance: () => ({ verifyToken: (...args: unknown[]) => mockVerifyToken(...args) }) },
}));
jest.mock('../../../src/core/prisma.service', () => ({
  prisma: { user: { findUnique: (...args: unknown[]) => mockUserFind(...args) } },
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

const PAGE = {
  data: [{ id: 1, address: '0x' + 'a'.repeat(40), addedAt: '2026-10-01T00:00:00.000Z' }],
  pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
};
const bearer = { Authorization: 'Bearer valid-token' };

describe('GET /wallet/', () => {
  let getAll: jest.SpyInstance;

  beforeEach(() => {
    mockVerifyToken.mockReset().mockResolvedValue({ sub: 'did:privy:abc' });
    mockUserFind.mockReset();
    getAll = jest.spyOn(WalletService.prototype, 'getAll').mockResolvedValue(PAGE as never);
  });

  afterEach(() => getAll.mockRestore());

  it('answers 401 without a token and lists nothing', async () => {
    const res = await request(app).get('/wallet/');

    expect(res.status).toBe(401);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('answers 403 to a signed-in user who is not an admin', async () => {
    mockUserFind.mockResolvedValue({ id: 7, role: 'USER', privyUserId: 'did:privy:abc' });

    const res = await request(app).get('/wallet/').set(bearer);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'INSUFFICIENT_PERMISSIONS' });
    expect(getAll).not.toHaveBeenCalled();
  });

  it('lists the wallets for an admin', async () => {
    mockUserFind.mockResolvedValue({ id: 1, role: 'ADMIN', privyUserId: 'did:privy:abc' });

    const res = await request(app).get('/wallet/?page=1&limit=10').set(bearer);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: PAGE.data, pagination: PAGE.pagination });
  });
});
