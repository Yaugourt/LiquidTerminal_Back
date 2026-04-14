import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const optionalNum = z.coerce.number().optional();
const ethAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid address');

const empty = {
  query: z.object({}),
  params: z.object({}),
};

export const hip3AssetsQuerySchema = z.object({
  query: z.object({
    dex_id: optionalString,
    search: optionalString,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const hip3AssetTickerParamsSchema = z.object({
  query: z.object({}),
  params: z.object({
    ticker: z.string().min(1).max(64),
  }),
});

export const hip3DexsQuerySchema = z.object({
  query: z.object({
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const hip3DexIdParamsSchema = z.object({
  query: z.object({}),
  params: z.object({
    dex_id: z.string().min(1).max(128),
  }),
});

export const hip3OverviewSchema = z.object(empty);

export const hip3PriorityFeesGossipStatusSchema = z.object(empty);

export const hip3PriorityFeesGossipHistoryQuerySchema = z.object({
  query: z.object({
    slot_id: z.coerce.number().int().min(0).max(4).optional(),
    start_time: optionalString,
    end_time: optionalString,
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(10000).optional(),
    order: z.enum(['ASC', 'DESC', 'asc', 'desc']).optional(),
  }),
  params: z.object({}),
});

export const hip3AuctionsQuerySchema = z.object({
  query: z.object({
    status: optionalString,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const hip3AuctionCurrentSchema = z.object(empty);

export const hip3AuctionsHistoryQuerySchema = z.object({
  query: z.object({
    dex_id: optionalString,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const hip3FillsQuerySchema = z.object({
  query: z.object({
    dex_id: optionalString,
    coin: optionalString,
    user: optionalString,
    side: z.string().max(16).optional(),
    start: optionalString,
    end: optionalString,
    min_notional: optionalNum,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const hip3LeaderboardQuerySchema = z.object({
  query: z.object({
    by: optionalString,
    dex_id: optionalString,
    limit: optionalNum,
  }),
  params: z.object({}),
});

export const hip3OhlcvQuerySchema = z.object({
  query: z.object({
    coin: z.string().min(1).max(128),
    dex_id: optionalString,
    start: optionalString,
    end: optionalString,
    limit: optionalNum,
  }),
  params: z.object({}),
});

export const hip3OracleStatsQuerySchema = z.object({
  query: z.object({
    dex_id: z.string().min(1).max(128),
    asset_id: optionalString,
    start: optionalString,
    end: optionalString,
    limit: optionalNum,
  }),
  params: z.object({}),
});

export const hip3SnapshotsQuerySchema = z.object({
  query: z.object({
    dex_id: optionalString,
    coin: optionalString,
  }),
  params: z.object({}),
});

export const hip3StatsTradersQuerySchema = z.object({
  query: z.object({
    dex_id: optionalString,
    coin: optionalString,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({}),
});

export const hip3TopMoversQuerySchema = z.object({
  query: z.object({
    limit: optionalNum,
  }),
  params: z.object({}),
});

export const hip3UserCoinsSchema = z.object({
  query: z.object({
    limit: optionalNum,
  }),
  params: z.object({
    address: ethAddress,
  }),
});

export const hip3UserFillsSchema = z.object({
  query: z.object({
    coin: optionalString,
    dex_id: optionalString,
    start: optionalString,
    end: optionalString,
    limit: optionalNum,
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: z.object({
    address: ethAddress,
  }),
});

export const hip3UserOverviewSchema = z.object({
  query: z.object({}),
  params: z.object({
    address: ethAddress,
  }),
});
