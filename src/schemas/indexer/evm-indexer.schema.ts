import { z } from 'zod';

export const evmStatsQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

export const evmStatsDailyQuerySchema = z.object({
  query: z.object({
    days: z.coerce.number().int().min(1).max(90).optional(),
  }),
  params: z.object({}),
});

export const evmBlocksQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    start_time: z.coerce.number().optional(),
    end_time: z.coerce.number().optional(),
  }),
  params: z.object({}),
});

export const evmTransactionsQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    block_number: z.coerce.number().int().optional(),
    to_addr: z.string().optional(),
    start_time: z.coerce.number().optional(),
    end_time: z.coerce.number().optional(),
  }),
  params: z.object({}),
});

export const evmBridgeEventsQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    start_time: z.coerce.number().optional(),
    end_time: z.coerce.number().optional(),
  }),
  params: z.object({}),
});

export const evmLedgerTransfersQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    start_time: z.coerce.number().optional(),
    end_time: z.coerce.number().optional(),
  }),
  params: z.object({}),
});
