import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const ethAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

export const indexerFundingHistoryQuerySchema = z.object({
  query: z.object({
    coin: z.string().min(1).max(128),
    startTime: optionalString,
    endTime: optionalString,
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  }),
  params: z.object({}),
});

export const indexerFundingPredictedQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

export const indexerFundingUserFundingQuerySchema = z.object({
  query: z.object({
    user: ethAddress,
    startTime: optionalString,
    endTime: optionalString,
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  }),
  params: z.object({}),
});
