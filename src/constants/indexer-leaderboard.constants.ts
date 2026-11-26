/** Windows the provider ranks ahead: every 5 min for 7d and 30d, every hour for `all`. */
export const LEADERBOARD_WINDOWS = ['7d', '30d', 'all'] as const;
export type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

/** Rankings that exist over a window only. */
export const LEADERBOARD_WINDOW_METRICS = ['win_rate', 'pnl_pct', 'unrealized_pnl'] as const;

export const LEADERBOARD_METRICS = ['volume', 'pnl', 'trades', 'priority_fees', ...LEADERBOARD_WINDOW_METRICS] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];
