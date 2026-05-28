import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const optionalNum = z.coerce.number().optional();
const ethAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');
const optionalEth = ethAddress.optional();

const vaultTimeOptional = {
  startTime: optionalString,
  endTime: optionalString,
  limit: optionalNum,
};

export const vaultsDetailsQuerySchema = z.object({
  query: z.object({
    vaultAddress: ethAddress,
    ...vaultTimeOptional,
  }),
  params: z.object({}),
});

export const vaultsSummariesQuerySchema = z.object({
  query: z.object({
    includeClosed: z.coerce.boolean().optional(),
    limit: optionalNum,
  }),
  params: z.object({}),
});

export const vaultsUserEquitiesQuerySchema = z.object({
  query: z.object({
    user: ethAddress,
    ...vaultTimeOptional,
  }),
  params: z.object({}),
});

export const vaultsDailySnapshotsQuerySchema = z.object({
  query: z.object({
    vaultAddress: ethAddress,
    ...vaultTimeOptional,
  }),
  params: z.object({}),
});

export const vaultsEquitySnapshotsQuerySchema = z.object({
  query: z.object({
    vaultAddress: ethAddress,
    ...vaultTimeOptional,
  }),
  params: z.object({}),
});

export const vaultsLedgerQuerySchema = z.object({
  query: z.object({
    vaultAddress: ethAddress,
    user: optionalEth,
    ...vaultTimeOptional,
  }),
  params: z.object({}),
});

const leaderboardWindow = z.enum(['24h', '7d']).optional();
const leaderboardLimit = z.coerce.number().int().min(1).max(50).optional();

export const vaultsLeaderboardFollowersQuerySchema = z.object({
  query: z.object({
    window: leaderboardWindow,
    limit: leaderboardLimit,
  }),
  params: z.object({}),
});

export const vaultsLeaderboardOutflowsQuerySchema = z.object({
  query: z.object({
    window: leaderboardWindow,
    limit: leaderboardLimit,
  }),
  params: z.object({}),
});
