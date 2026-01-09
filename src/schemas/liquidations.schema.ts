import { z } from 'zod';

/**
 * Schéma de validation pour les paramètres query des liquidations
 */
export const liquidationsQuerySchema = z.object({
  query: z.object({
    coin: z.string().optional(),
    user: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
      .optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    amount_dollars: z.coerce
      .number()
      .min(0, 'amount_dollars must be >= 0')
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be >= 1')
                  .max(1000, 'limit must be <= 1000')
      .optional()
      .default(100),
    cursor: z.string().optional(),
    order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional().default('DESC')
  }),
  params: z.object({})
});

/**
 * Schéma pour les liquidations récentes (avec paramètre hours)
 */
export const recentLiquidationsQuerySchema = z.object({
  query: z.object({
    coin: z.string().optional(),
    user: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
      .optional(),
    // Hours filter for time-based filtering (2h, 4h, 8h, 12h, 24h)
    hours: z.coerce
      .number()
      .int()
      .min(1, 'hours must be >= 1')
      .max(168, 'hours must be <= 168')
      .optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    amount_dollars: z.coerce
      .number()
      .min(0, 'amount_dollars must be >= 0')
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be >= 1')
                  .max(1000, 'limit must be <= 1000')
      .optional()
      .default(100),
    cursor: z.string().optional(),
    order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional().default('DESC')
  }),
  params: z.object({})
});

export type LiquidationsQueryInput = z.infer<typeof liquidationsQuerySchema>;
export type RecentLiquidationsQueryInput = z.infer<typeof recentLiquidationsQuerySchema>;

