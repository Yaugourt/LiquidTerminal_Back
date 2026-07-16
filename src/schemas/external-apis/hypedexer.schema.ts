import { z } from 'zod';

/**
 * Zod schemas for HypeDexer API responses.
 * Used to validate external API data before processing.
 */

export const liquidationItemSchema = z.object({
  tid: z.number(),
  time: z.string(),
  time_ms: z.number(),
  coin: z.string(),
  hash: z.string(),
  liquidated_user: z.string(),
  size_total: z.number(),
  notional_total: z.number(),
  fill_px_vwap: z.number().nullable(),
  mark_px: z.number(),
  method: z.string(),
  fee_total_liquidated: z.number(),
  liquidators: z.array(z.string()),
  liquidator_count: z.number(),
  // HypeDexer emits null for liquidations with no resolved direction.
  liq_dir: z.string().nullable(),
}).passthrough(); // Allow extra fields we don't use

export const liquidationsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.array(liquidationItemSchema),
  total_count: z.number().nullable().optional(),
  execution_time_ms: z.number().optional(),
  next_cursor: z.string().nullable().optional(),
  has_more: z.boolean().optional(),
}).passthrough();

export const liquidationStatsSchema = z.object({
  total_liquidations: z.number(),
  total_notional: z.number(),
  avg_notional: z.number(),
  top_coins: z.array(z.object({
    coin: z.string(),
    count: z.number(),
    notional: z.number(),
  })).optional(),
}).passthrough();

export type ValidatedLiquidation = z.infer<typeof liquidationItemSchema>;
export type ValidatedLiquidationsResponse = z.infer<typeof liquidationsResponseSchema>;
