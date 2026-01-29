import { z } from 'zod';

/**
 * Schema for top traders query parameters
 * GET /top-traders
 */
export const topTradersQuerySchema = z.object({
  query: z.object({
    sort: z
      .enum(['pnl_pos', 'pnl_neg', 'volume', 'trades'])
      .optional()
      .default('pnl_pos'),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(50, 'limit must be <= 50')
      .optional()
      .default(50)
  }),
  params: z.object({})
});

export type TopTradersQueryInput = z.infer<typeof topTradersQuerySchema>;
