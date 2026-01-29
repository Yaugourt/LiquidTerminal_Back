import { z } from 'zod';

/**
 * Schema for active users query parameters
 * GET /active-users
 */
export const activeUsersQuerySchema = z.object({
  query: z.object({
    hours: z.coerce
      .number()
      .int()
      .min(1, 'hours must be >= 1')
      .max(168, 'hours must be <= 168')
      .optional()
      .default(24),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(100, 'limit must be <= 100')
      .optional()
      .default(100)
  }),
  params: z.object({})
});

export type ActiveUsersQueryInput = z.infer<typeof activeUsersQuerySchema>;
