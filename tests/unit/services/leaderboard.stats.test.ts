/** GET /leaderboard/stats aggregates over every participant, not the first 1,000. */
const mockGetData = jest.fn();
jest.mock('../../../src/clients/hyperliquid/leaderboard/leaderboard.client', () => ({
  HyperliquidLeaderboardClient: {
    getInstance: () => ({ getLeaderboardData: mockGetData, getLastUpdate: () => 0 }),
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { LeaderboardService } from '../../../src/services/leaderboard/leaderboard.service';

const row = (i: number, pnl: number, accountValue: number, vlm: number) => ({
  ethAddress: `0x${i}`,
  accountValue: String(accountValue),
  displayName: `t${i}`,
  prize: 0,
  windowPerformances: [['allTime', { pnl: String(pnl), roi: '0', vlm: String(vlm) }]],
});

describe('LeaderboardService.getStats', () => {
  it('sums and averages every row, past the first 1,000', async () => {
    // 1,000 winners with a big account, then 1,000 small accounts that lose a little.
    const rows = [
      ...Array.from({ length: 1000 }, (_, i) => row(i, 10, 1000, 100)),
      ...Array.from({ length: 1000 }, (_, i) => row(1000 + i, -1, 0, 10)),
    ];
    mockGetData.mockResolvedValue({ leaderboardRows: rows });

    const stats = await LeaderboardService.getInstance().getStats();

    expect(stats.totalParticipants).toBe(2000);
    expect(stats.averageAccountValue).toBe(500);
    expect(stats.totalVolume).toBe(1000 * 100 + 1000 * 10);
    expect(stats.totalPnl).toBe(1000 * 10 - 1000);
    expect(stats.topPerformer?.displayName).toBe('t0');
  });

  it('answers zeros, not NaN, for an empty board', async () => {
    mockGetData.mockResolvedValue({ leaderboardRows: [] });

    expect(await LeaderboardService.getInstance().getStats()).toEqual({
      totalParticipants: 0,
      topPerformer: null,
      averageAccountValue: 0,
      totalVolume: 0,
      totalPnl: 0,
    });
  });
});
