import { z } from 'zod';

const analyticsHoursCoinQuery = {
  hours: z.coerce.number().int().min(1).max(168).optional(),
  coin: z.string().max(64).optional(),
};

export const indexerAnalyticsFillsStatsQuerySchema = z.object({
  query: z.object(analyticsHoursCoinQuery),
  params: z.object({}),
});

export const indexerAnalyticsPriorityFeesStatsQuerySchema = z.object({
  query: z.object(analyticsHoursCoinQuery),
  params: z.object({}),
});
