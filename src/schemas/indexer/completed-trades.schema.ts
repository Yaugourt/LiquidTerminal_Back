import { z } from 'zod';
import { indexerBoundedNumber, indexerOffset, indexerTime } from './bounds';

const optionalString = z.string().max(256).optional();
/** Realized-PnL filters: finite, within any real trade. */
const pnlBound = indexerBoundedNumber(1e12);

const listQueryShape = {
  user: optionalString,
  coin: optionalString,
  direction: z.string().max(16).optional(),
  start_time: indexerTime,
  end_time: indexerTime,
  min_pnl: pnlBound,
  max_pnl: pnlBound,
  offset: indexerOffset,
  // Every row returned is billed upstream: an unbounded limit let one request
  // spend thousands of credits.
  limit: z.coerce.number().int().min(1).max(1000).optional(),
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
    start_time: indexerTime,
    end_time: indexerTime,
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
