import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const optionalNum = z.coerce.number().optional();

export const spotAuctionsHistQuerySchema = z.object({
  query: z.object({
    lookback_hours: optionalNum,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const spotAuctionsLiveQuerySchema = z.object({
  query: z.object({
    freshness_sec: optionalNum,
  }),
  params: z.object({}),
});

export const spotPairsQuerySchema = z.object({
  query: z.object({
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const spotTokensQuerySchema = z.object({
  query: z.object({
    search: optionalString,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});
