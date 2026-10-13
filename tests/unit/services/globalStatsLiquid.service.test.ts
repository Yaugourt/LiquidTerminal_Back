/**
 * GET /home/globalstats assembles four sources; each answers on its own:
 * - a cold Redis (validator and vault caches empty until their pollers' first
 *   write) answers 200 with those fields null, not a 500;
 * - a source that fails later answers its last value for
 *   GLOBAL_STATS_LAST_GOOD_MAX_AGE_MS, then null;
 * - a source that recovers answers its new value at once.
 */
const mockGetGlobalStats = jest.fn();
const mockGetLatestBridgedUsdc = jest.fn();
const mockGetValidatorSummaries = jest.fn();
const mockGetVaultsList = jest.fn();

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../../src/clients/hyperliquid/globalstats.client', () => ({
  HyperliquidGlobalStatsClient: { getInstance: () => ({ getGlobalStats: mockGetGlobalStats }) },
}));
jest.mock('../../../src/services/bridgedUsdc.service', () => ({
  BridgedUsdcService: jest.fn().mockImplementation(() => ({ getLatestBridgedUsdc: mockGetLatestBridgedUsdc })),
}));
jest.mock('../../../src/services/staking/validator.service', () => ({
  ValidatorSummariesService: { getInstance: () => ({ getValidatorSummaries: mockGetValidatorSummaries }) },
}));
jest.mock('../../../src/services/vault/vaults.service', () => ({
  VaultsService: { getInstance: () => ({ getVaultsList: mockGetVaultsList }) },
}));

import express from 'express';
import request from 'supertest';
import globalStatsRoutes from '../../../src/routes/globalStats.routes';
import {
  DashboardGlobalStatsService,
  GLOBAL_STATS_LAST_GOOD_MAX_AGE_MS,
} from '../../../src/services/globalStatsLiquid.service';
import { logDeduplicator } from '../../../src/utils/logDeduplicator';

const FULL = {
  numberOfUsers: 812_000,
  dailyVolume: 9_500_000_000,
  bridgedUsdc: 5_812_345_678,
  totalHypeStake: 300_000_000,
  vaultsTvl: 512_000_000,
};

const cacheEmpty = (what: string) => new Error(`No ${what} data available in cache`);

function allSourcesUp(): void {
  mockGetGlobalStats.mockResolvedValue({ nUsers: 812_000, dailyVolume: 9_500_000_000, totalVolume: 1 });
  mockGetLatestBridgedUsdc.mockResolvedValue(5_812_345_678);
  // 3e16 raw units (8 decimals) = 300,000,000 HYPE.
  mockGetValidatorSummaries.mockResolvedValue([{ stake: 10_000_000_000_000_000 }, { stake: 20_000_000_000_000_000 }]);
  mockGetVaultsList.mockResolvedValue({ pagination: { totalTvl: 512_000_000 } });
}

describe('DashboardGlobalStatsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allSourcesUp();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers every field when every source answers', async () => {
    await expect(new DashboardGlobalStatsService().getDashboardGlobalStats()).resolves.toEqual(FULL);
    expect(logDeduplicator.warn).not.toHaveBeenCalled();
  });

  it('answers the other fields with nulls while the validator and vault caches are empty', async () => {
    mockGetValidatorSummaries.mockRejectedValue(cacheEmpty('validator'));
    mockGetVaultsList.mockRejectedValue(cacheEmpty('vaults'));

    await expect(new DashboardGlobalStatsService().getDashboardGlobalStats()).resolves.toEqual({
      ...FULL,
      totalHypeStake: null,
      vaultsTvl: null,
    });
    expect(logDeduplicator.warn).toHaveBeenCalledWith('Dashboard global stats served without some sources', {
      failed: { validators: 'No validator data available in cache', vaults: 'No vaults data available in cache' },
    });
  });

  it('answers nulls, without throwing, when every source fails', async () => {
    mockGetGlobalStats.mockRejectedValue(new Error('circuit open'));
    mockGetLatestBridgedUsdc.mockRejectedValue(new Error('unexpected'));
    mockGetValidatorSummaries.mockRejectedValue(cacheEmpty('validator'));
    mockGetVaultsList.mockRejectedValue(cacheEmpty('vaults'));

    await expect(new DashboardGlobalStatsService().getDashboardGlobalStats()).resolves.toEqual({
      numberOfUsers: null,
      dailyVolume: null,
      bridgedUsdc: null,
      totalHypeStake: null,
      vaultsTvl: null,
    });
  });

  it('answers a failing source with its last value, then null once that value is too old', async () => {
    jest.useFakeTimers({ now: 1_791_000_000_000 });
    const service = new DashboardGlobalStatsService();
    await service.getDashboardGlobalStats();

    // Hyperliquid down past its 5 min cache, the validator key evicted.
    mockGetGlobalStats.mockRejectedValue(new Error('circuit open'));
    mockGetValidatorSummaries.mockRejectedValue(cacheEmpty('validator'));
    jest.setSystemTime(Date.now() + GLOBAL_STATS_LAST_GOOD_MAX_AGE_MS);
    await expect(service.getDashboardGlobalStats()).resolves.toEqual(FULL);

    jest.setSystemTime(Date.now() + 1);
    await expect(service.getDashboardGlobalStats()).resolves.toEqual({
      ...FULL,
      numberOfUsers: null,
      dailyVolume: null,
      totalHypeStake: null,
    });
  });

  it('answers a recovered source with its new value at once', async () => {
    const service = new DashboardGlobalStatsService();
    mockGetVaultsList.mockRejectedValueOnce(cacheEmpty('vaults'));
    await expect(service.getDashboardGlobalStats()).resolves.toEqual({ ...FULL, vaultsTvl: null });

    mockGetVaultsList.mockResolvedValue({ pagination: { totalTvl: 600_000_000 } });
    await expect(service.getDashboardGlobalStats()).resolves.toEqual({ ...FULL, vaultsTvl: 600_000_000 });
  });

  it('never mixes up the sources of different fields', async () => {
    const service = new DashboardGlobalStatsService();
    await service.getDashboardGlobalStats();

    mockGetGlobalStats.mockResolvedValue({ nUsers: 900_000, dailyVolume: 1_000, totalVolume: 1 });
    mockGetValidatorSummaries.mockRejectedValue(cacheEmpty('validator'));
    await expect(service.getDashboardGlobalStats()).resolves.toEqual({
      ...FULL,
      numberOfUsers: 900_000,
      dailyVolume: 1_000,
    });
  });
});

describe('GET /home/globalstats on a cold Redis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allSourcesUp();
  });

  it('answers 200 with the fields it has instead of a 500', async () => {
    mockGetValidatorSummaries.mockRejectedValue(cacheEmpty('validator'));
    mockGetVaultsList.mockRejectedValue(cacheEmpty('vaults'));
    const app = express();
    app.use('/home/globalstats', globalStatsRoutes);

    const res = await request(app).get('/home/globalstats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...FULL, totalHypeStake: null, vaultsTvl: null });
  });
});
