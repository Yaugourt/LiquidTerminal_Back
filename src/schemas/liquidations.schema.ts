import { z } from 'zod';

/**
 * These routes forward their parameters to HypeDexer (billed per call) and
 * put them in Redis keys, so every free-form value is a way to mint a fresh
 * paid miss. Each one is bounded to what a real caller sends.
 */

/** A perp (`BTC`, `kPEPE`), a HIP-3 market (`xyz:AAPL`) or a spot pair (`@107`, `PURR/USDC`). */
export const LIQUIDATION_COIN_PATTERN = /^(?:@\d{1,5}|[A-Za-z0-9]{1,12}\/USDC|[A-Za-z0-9][A-Za-z0-9._-]{0,19}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,31})?)$/;

/** Keyset cursor, `<time_ms>:<tid>` (see HypeDexer's /liquidations). */
const CURSOR_PATTERN = /^\d{1,16}:[A-Za-z0-9_-]{1,40}$/;

/** ISO 8601 date-time, the only format HypeDexer takes for start_time / end_time. */
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Hyperliquid mainnet launched in 2023: nothing older exists. */
const MIN_TIME_MS = Date.UTC(2023, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

const coinParam = z.string().regex(LIQUIDATION_COIN_PATTERN, 'Invalid coin');
const cursorParam = z.string().regex(CURSOR_PATTERN, 'Invalid cursor');
const timeParam = z
  .string()
  .max(40)
  .regex(ISO_TIME_PATTERN, 'Time must be an ISO 8601 date-time')
  .refine((value) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms >= MIN_TIME_MS && ms <= Date.now() + DAY_MS;
  }, 'Time out of range');
const amountParam = z.coerce.number().min(0, 'amount_dollars must be >= 0').max(1e12, 'amount_dollars is too large');

/**
 * Schéma de validation pour les paramètres query des liquidations
 */
export const liquidationsQuerySchema = z.object({
  query: z.object({
    coin: coinParam.optional(),
    user: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
      .optional(),
    start_time: timeParam.optional(),
    end_time: timeParam.optional(),
    amount_dollars: amountParam.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(1000, 'limit must be <= 1000')
      .optional()
      .default(100),
    cursor: cursorParam.optional(),
    order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional().default('DESC')
  }),
  params: z.object({})
});

/**
 * Schéma pour les liquidations récentes (avec paramètre hours)
 */
export const recentLiquidationsQuerySchema = z.object({
  query: z.object({
    coin: coinParam.optional(),
    user: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
      .optional(),
    // Hours filter for time-based filtering (2h, 4h, 8h, 12h, 24h)
    hours: z.coerce
      .number()
      .int()
      .min(1, 'hours must be >= 1')
      .max(168, 'hours must be <= 168')
      .optional(),
    start_time: timeParam.optional(),
    end_time: timeParam.optional(),
    amount_dollars: amountParam.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(1000, 'limit must be <= 1000')
      .optional()
      .default(100),
    cursor: cursorParam.optional(),
    order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional().default('DESC')
  }),
  params: z.object({})
});

/** GET /liquidations/analytics/stats: `days` is checked by the route, only `coin` is free-form. */
export const analyticsStatsQuerySchema = z.object({
  query: z.object({
    coin: coinParam.optional(),
  }),
  params: z.object({}),
});

export type LiquidationsQueryInput = z.infer<typeof liquidationsQuerySchema>;
export type RecentLiquidationsQueryInput = z.infer<typeof recentLiquidationsQuerySchema>;

