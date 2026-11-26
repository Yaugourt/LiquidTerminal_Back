import { z } from 'zod';
import { indexerTime, MAX_INDEXER_OFFSET } from './bounds';
import {
  LEADERBOARD_METRICS,
  LEADERBOARD_WINDOWS,
  LEADERBOARD_WINDOW_METRICS,
} from '../../constants/indexer-leaderboard.constants';

const ethUser = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid user');

const timeRangeQuery = {
  start_time: indexerTime,
  end_time: indexerTime,
};

/**
 * Without `window`: the last `hours` (168 at most), 100 rows, one page. With it: a ranking over 7d,
 * 30d or all time, page by page. Pages, sizes and rankings are cache keys and billed reads: the
 * depth is bounded as everywhere else (MAX_INDEXER_OFFSET).
 */
export const indexerUsersLeaderboardQuerySchema = z.object({
  query: z.object({
    by: z.enum(LEADERBOARD_METRICS).optional().default('volume'),
    hours: z.coerce.number().int().min(1).max(168).optional().default(24),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    window: z.enum(LEADERBOARD_WINDOWS).optional(),
    page: z.coerce.number().int().min(1).optional(),
  }),
  params: z.object({}),
}).refine(
  ({ query }) => query.window !== undefined || !(LEADERBOARD_WINDOW_METRICS as readonly string[]).includes(query.by),
  { message: `${LEADERBOARD_WINDOW_METRICS.join(', ')} need a window`, path: ['query', 'by'] }
).refine(
  ({ query }) => query.window !== undefined || query.page === undefined,
  { message: 'page needs a window', path: ['query', 'page'] }
).refine(
  ({ query }) => ((query.page ?? 1) - 1) * query.limit <= MAX_INDEXER_OFFSET,
  { message: `No deeper than ${MAX_INDEXER_OFFSET} rows`, path: ['query', 'page'] }
);

export const indexerUsersCoinsQuerySchema = z.object({
  query: z.object({
    ...timeRangeQuery,
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  params: z.object({ user: ethUser }),
});

export const indexerUsersOverviewQuerySchema = z.object({
  query: z.object({ ...timeRangeQuery }),
  params: z.object({ user: ethUser }),
});

export const indexerUsersPerformanceQuerySchema = z.object({
  query: z.object({ ...timeRangeQuery }),
  params: z.object({ user: ethUser }),
});
