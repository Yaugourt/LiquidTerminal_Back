import { z } from 'zod';

const ethAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid builder address');

const timeframeEnum = z.enum(['1h', '24h', '7d', '30d']);

export const indexerBuildersListQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

export const indexerBuildersStatsQuerySchema = z.object({
  query: z.object({
    timeframe: timeframeEnum.optional(),
  }),
  params: z.object({}),
});

export const indexerBuildersStatsAllTimeframesQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

export const indexerBuildersTopQuerySchema = z.object({
  query: z.object({
    timeframe: timeframeEnum.optional(),
    sort: z.string().max(32).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  params: z.object({}),
});

export const indexerBuilderAddressStatsQuerySchema = z.object({
  query: z.object({
    timeframe: timeframeEnum.optional(),
  }),
  params: z.object({
    builder_address: ethAddress,
  }),
});

export const indexerBuilderAddressUsersQuerySchema = z.object({
  query: z.object({
    timeframe: timeframeEnum.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  params: z.object({
    builder_address: ethAddress,
  }),
});
