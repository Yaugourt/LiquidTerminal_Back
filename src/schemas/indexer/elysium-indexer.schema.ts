import { z } from 'zod';

/** Query-string boolean: only the literals "true" / "false" are accepted. */
const queryBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

const limit = (max: number) => z.coerce.number().int().min(1).max(max).optional();

const noParams = z.object({});

/** Which Elysium chain to read: testnet (99801, default) or mainnet (99901). */
export const elysiumNetwork = z.enum(['testnet', 'mainnet']).optional();

export const elysiumStatsQuerySchema = z.object({
  query: z.object({ network: elysiumNetwork }),
  params: noParams,
});

export const elysiumStatsDailyQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    days: z.coerce.number().int().min(1).max(365).optional(),
  }),
  params: noParams,
});

export const elysiumBlocksQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
  }),
  params: noParams,
});

export const elysiumTransactionsQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
    include_spam: queryBoolean.optional(),
    include_system: queryBoolean.optional(),
  }),
  params: noParams,
});

/** Upstream default is 100; default to our cap so the omitted case stays bounded. */
export const elysiumBatchesQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: z.coerce.number().int().min(1).max(50).default(50),
  }),
  params: noParams,
});

export const elysiumBridgeTransfersQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
    direction: z.enum(['deposit', 'withdrawal']).optional(),
    status: z
      .enum(['initiated', 'ticket_created', 'redeem_failed', 'expired', 'completed', 'executed'])
      .optional(),
    route: z.enum(['native', 'canonical', 'mirror']).optional(),
    asset: z.enum(['native', 'token', 'message']).optional(),
  }),
  params: noParams,
});

export const elysiumBridgeRetryablesQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
    status: z.enum(['pending', 'failed', 'expired', 'redeemed']).optional(),
  }),
  params: noParams,
});

/**
 * `route` is required: the unfiltered upstream response is truncated at 1000 rows.
 */
export const elysiumBridgeReservesQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    route: z.enum(['native', 'canonical', 'mirror']),
    only_unbacked: queryBoolean.optional(),
  }),
  params: noParams,
});

export const elysiumBridgeTokensQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
    route: z.enum(['canonical', 'mirror']).optional(),
  }),
  params: noParams,
});

export const elysiumTokensQuerySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
    standard: z.enum(['erc20', 'erc721', 'erc1155']).optional(),
    origin: z.enum(['native', 'canonical']).optional(),
  }),
  params: noParams,
});

const addressParams = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

export const elysiumUserBalancesSchema = z.object({
  query: z.object({ network: elysiumNetwork }),
  params: addressParams,
});

export const elysiumUserActivitySchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
    offset: z.coerce.number().int().min(0).max(10_000).optional(),
  }),
  params: addressParams,
});

export const elysiumUserBridgeSchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
    direction: z.enum(['deposit', 'withdrawal']).optional(),
  }),
  params: addressParams,
});

/** Largest holders of one token, with their share of supply. */
export const elysiumTokenHoldersSchema = z.object({
  query: z.object({
    network: elysiumNetwork,
    limit: limit(100),
  }),
  params: addressParams,
});

export const elysiumTokenDetailSchema = z.object({
  query: z.object({ network: elysiumNetwork }),
  params: addressParams,
});
