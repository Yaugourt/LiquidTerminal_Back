import { z } from 'zod';

const ethUser = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid user');

const timeRangeQuery = {
  start_time: z.string().max(64).optional(),
  end_time: z.string().max(64).optional(),
};

export const indexerUsersLeaderboardQuerySchema = z.object({
  query: z.object({
    by: z.enum(['volume', 'pnl', 'trades']).optional().default('volume'),
    hours: z.coerce.number().int().min(1).max(168).optional().default(24),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
  params: z.object({}),
});

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
