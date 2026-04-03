import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const optionalNum = z.coerce.number().optional();

/**
 * Query validation for GET /indexer/fills, /indexer/fills/recent (mirrors OpenAPI query params).
 */
const fillsQueryShape = {
  user: optionalString,
  coin: optionalString,
  side: z.string().max(8).optional(),
  size_usd: optionalNum,
  start_time: optionalString,
  end_time: optionalString,
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: optionalString,
  order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
};

export const indexerFillsQuerySchema = z.object({
  query: z.object(fillsQueryShape),
  params: z.object({}),
});

export const indexerFillsCountQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

const ethAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid user address');

const userFillsQueryShape = {
  time_range: z.string().max(64).optional(),
  coin: optionalString,
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: optionalString,
  order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
};

export const indexerFillsUserAddressQuerySchema = z.object({
  query: z.object(userFillsQueryShape),
  params: z.object({
    user_address: ethAddress,
  }),
});

const spotFillsQueryShape = {
  user: optionalString,
  coin: optionalString,
  coins: optionalString,
  side: z.string().max(8).optional(),
  start_time: optionalString,
  end_time: optionalString,
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
};

export const indexerFillsSpotQuerySchema = z.object({
  query: z.object(spotFillsQueryShape),
  params: z.object({}),
});

export const indexerFillsSpotUserQuerySchema = z.object({
  query: z.object({
    coin: optionalString,
    coins: optionalString,
    start_time: optionalString,
    end_time: optionalString,
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
  }),
  params: z.object({
    user_address: ethAddress,
  }),
});
