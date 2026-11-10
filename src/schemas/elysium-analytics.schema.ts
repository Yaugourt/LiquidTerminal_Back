import { z } from 'zod';
import type { Launchpad } from '../services/elysium/elysium-launchpad.util';

const noParams = z.object({});

const days = z.coerce.number().int().min(1).max(60).default(14);

/** GET /elysium/analytics/status */
export const elysiumAnalyticsStatusSchema = z.object({
  query: z.object({}),
  params: noParams,
});

/** GET /elysium/analytics/{deployments,users,bridge,economics}?days=1..60 (default 14) */
export const elysiumAnalyticsDaysSchema = z.object({
  query: z.object({ days }),
  params: noParams,
});

/** GET /elysium/analytics/contracts?window=24h|7d (default 24h) */
export const elysiumAnalyticsContractsSchema = z.object({
  query: z.object({ window: z.enum(['24h', '7d']).default('24h') }),
  params: noParams,
});

export type ElysiumAnalyticsDaysQuery = z.infer<typeof elysiumAnalyticsDaysSchema>['query'];
export type ElysiumAnalyticsContractsQuery = z.infer<typeof elysiumAnalyticsContractsSchema>['query'];

/** GET /elysium/analytics/methods?window=24h|7d (default 24h) */
export const elysiumAnalyticsMethodsSchema = elysiumAnalyticsContractsSchema;

/** GET /elysium/analytics/address/:address */
export const elysiumAnalyticsAddressSchema = z.object({
  query: z.object({}),
  params: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
});

/** GET /elysium/analytics/fees?window=24h|7d|30d (default 7d) */
export const elysiumAnalyticsFeesSchema = z.object({
  query: z.object({ window: z.enum(['24h', '7d', '30d']).default('7d') }),
  params: noParams,
});

/** The orders of the launchpad token list. */
export const LAUNCHPAD_SORTS = ['hot', 'new', 'gainers', 'mcap'] as const;
export type LaunchpadSort = (typeof LAUNCHPAD_SORTS)[number];
export const LAUNCHPAD_NAMES = ['Chainzy', 'CorePad', 'Signal', 'Neuriio', 'aka.fun', 'BunnyPad', 'Kiln'] as const satisfies readonly Launchpad[];
/** Rows a request asks for: a multiple of the step, up to the ceiling. */
export const LAUNCHPAD_PAGE_STEP = 50;
export const LAUNCHPAD_MAX_ROWS = 5_000;

/**
 * GET /elysium/analytics/launchpads?pad=&sort=hot|new|gainers|mcap&q=&limit=
 * The first `limit` tokens of an order: 50 by default, in steps of 50 up to 5,000
 * (the page asks for 50 more each time). `q` matches symbol, name or address.
 */
export const elysiumAnalyticsLaunchpadsSchema = z.object({
  query: z.object({
    pad: z.enum(LAUNCHPAD_NAMES).optional(),
    sort: z.enum(LAUNCHPAD_SORTS).default('hot'),
    q: z
      .string()
      .trim()
      .max(64)
      .optional()
      .transform((v) => v || undefined),
    limit: z.coerce
      .number()
      .int()
      .min(LAUNCHPAD_PAGE_STEP)
      .max(LAUNCHPAD_MAX_ROWS)
      .refine((n) => n % LAUNCHPAD_PAGE_STEP === 0, { message: `limit must be a multiple of ${LAUNCHPAD_PAGE_STEP}` })
      .default(LAUNCHPAD_PAGE_STEP),
  }),
  params: noParams,
});
