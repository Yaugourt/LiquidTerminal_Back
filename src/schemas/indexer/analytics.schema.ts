import { z } from 'zod';

export const indexerAnalyticsFillsStatsQuerySchema = z.object({
  query: z.object({
    hours: z.coerce.number().int().min(1).max(168).optional(),
    coin: z.string().max(64).optional(),
  }),
  params: z.object({}),
});
