import { z } from 'zod';

const ethAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

/** Most overview GETs only need optional X-API-Key (sent by client, not query). */
export const indexerOverviewEmptyQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

/** OpenAPI: GET /overview/coin-distribution requires query `user`. */
export const indexerOverviewCoinDistributionQuerySchema = z.object({
  query: z.object({
    user: ethAddress,
  }),
  params: z.object({}),
});
