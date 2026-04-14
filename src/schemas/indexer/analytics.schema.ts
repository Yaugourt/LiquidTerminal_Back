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

export const indexerAnalyticsPriorityFeesFillsTimeseriesQuerySchema = z.object({
  query: z.object({
    hours: z.preprocess(
      (v) => (v === undefined || v === null || v === '' ? 24 : v),
      z.coerce.number().int().min(1).max(168)
    ),
    bucket_hours: z.preprocess(
      (v) => (v === undefined || v === null || v === '' ? 1 : v),
      z.coerce
        .number()
        .int()
        .refine((n): n is 1 | 6 | 24 => n === 1 || n === 6 || n === 24, {
          message: 'bucket_hours must be 1, 6, or 24',
        })
    ),
  }),
  params: z.object({}),
});
