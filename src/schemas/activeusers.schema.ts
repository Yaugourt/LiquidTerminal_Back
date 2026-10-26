import { z } from 'zod';
import { ACTIVE_USERS_HOURS } from '../types/activeusers.types';

/**
 * Schema for active users query parameters
 * GET /active-users
 *
 * `hours` is one of the windows the site offers (ACTIVE_USERS_HOURS): any
 * other value would be an uncached billed HypeDexer call per request.
 */
export const activeUsersQuerySchema = z.object({
  query: z.object({
    hours: z.coerce
      .number()
      .int()
      .refine((hours) => (ACTIVE_USERS_HOURS as readonly number[]).includes(hours), {
        message: `hours must be one of ${ACTIVE_USERS_HOURS.join(', ')}`,
      })
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
