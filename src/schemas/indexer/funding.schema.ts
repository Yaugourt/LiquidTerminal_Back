import { z } from 'zod';
import { indexerTime } from './bounds';

const ethAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

export const indexerFundingHistoryQuerySchema = z.object({
  query: z.object({
    coin: z.string().min(1).max(128),
    startTime: indexerTime,
    endTime: indexerTime,
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
    startTime: indexerTime,
    endTime: indexerTime,
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  }),
  params: z.object({}),
});
