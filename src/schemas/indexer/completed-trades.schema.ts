import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const optionalNum = z.coerce.number().optional();

const listQueryShape = {
  user: optionalString,
  coin: optionalString,
  direction: z.string().max(16).optional(),
  start_time: optionalString,
  end_time: optionalString,
  min_pnl: optionalNum,
  max_pnl: optionalNum,
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).optional(),
  do_count: z.coerce.boolean().optional(),
  sort_by: z.string().max(64).optional(),
  sort_dir: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
};

export const indexerCompletedTradesListQuerySchema = z.object({
  query: z.object(listQueryShape),
  params: z.object({}),
});

export const indexerCompletedTradesSummaryQuerySchema = z.object({
  query: z.object({
    user: optionalString,
    coin: optionalString,
    direction: z.string().max(16).optional(),
    start_time: optionalString,
    end_time: optionalString,
  }),
  params: z.object({}),
});

const tradeIdParam = z.string().min(1).max(256);

export const indexerCompletedTradesFillsParamsSchema = z.object({
  query: z.object({}),
  params: z.object({
    trade_id: tradeIdParam,
  }),
});
