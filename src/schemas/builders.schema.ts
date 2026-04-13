import { z } from 'zod';

/**
 * Schema for builders list query parameters
 * GET /builders
 */
export const buildersListQuerySchema = z.object({
  query: z.object({
    page: z.coerce
      .number()
      .int()
      .min(1, 'page must be >= 1')
      .optional()
      .default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(100, 'limit must be <= 100')
      .optional()
      .default(20),
    sortBy: z
      .enum(['volume_usd', 'fees_usd', 'trades_count', 'unique_users', 'name'])
      .optional()
      .default('volume_usd'),
    sortOrder: z
      .enum(['asc', 'desc'])
      .optional()
      .default('desc'),
    search: z
      .string()
      .max(100)
      .optional()
  }),
  params: z.object({})
});

/**
 * Schema for builders stats query (no params needed)
 * GET /builders/stats
 */
export const buildersStatsQuerySchema = z.object({
  query: z.object({}),
  params: z.object({})
});

export type BuildersListQueryInput = z.infer<typeof buildersListQuerySchema>;
export type BuildersStatsQueryInput = z.infer<typeof buildersStatsQuerySchema>;
