import { z } from 'zod';

/**
 * DefiLlama proxy validation (GET-only). Query/params only — never `body`,
 * which is undefined on GET (see CLAUDE.md "Indexer / HypeDexer GET routes").
 */

/** DefiLlama protocol slug: lowercase alphanumerics and dashes (e.g. `hyperliquid-bridge`). */
const protocolSlug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid protocol slug');

/** Comma-separated coin ids in `{chain}:{address}` or `coingecko:{id}` form. */
const coinIds = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[A-Za-z0-9:_,.-]+$/, 'Invalid coin ids');

const feesDataType = z.enum(['dailyFees', 'dailyRevenue']).optional();

export const defillamaEmptyQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

export const defillamaSlugParamSchema = z.object({
  query: z.object({}),
  params: z.object({ slug: protocolSlug }),
});

export const defillamaFeesSchema = z.object({
  query: z.object({ dataType: feesDataType }),
  params: z.object({ slug: protocolSlug }),
});

export const defillamaPricesParamSchema = z.object({
  query: z.object({}),
  params: z.object({ coins: coinIds }),
});
