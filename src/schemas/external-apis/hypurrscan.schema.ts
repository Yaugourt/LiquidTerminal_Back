import { z } from 'zod';

/**
 * Zod schemas for Hypurrscan API responses.
 */

export const validatorSchema = z.object({
  validator: z.string(),
  name: z.string().optional(),
  stake: z.string().or(z.number()),
  isJailed: z.boolean().optional(),
}).passthrough();

export const validatorsResponseSchema = z.array(validatorSchema);

export const unstakingEntrySchema = z.object({
  time: z.number(),
  user: z.string(),
  wei: z.number(),
}).passthrough();

export const unstakingResponseSchema = z.array(unstakingEntrySchema);

export const feeEntrySchema = z.object({
  time: z.number(),
  total_fees: z.number(),
  total_spot_fees: z.number(),
}).passthrough();

export const feesResponseSchema = z.array(feeEntrySchema);

export const stakedHoldersSchema = z.object({
  token: z.string(),
  lastUpdate: z.number(),
  holders: z.record(z.string(), z.number()),
  holdersCount: z.number(),
}).passthrough();

export const auctionInfoSchema = z.object({
  time: z.number(),
  deployer: z.string(),
  name: z.string(),
  deployGas: z.string(),
  tokenId: z.string().optional(),
}).passthrough();

export const auctionsResponseSchema = z.array(auctionInfoSchema);

export type ValidatedValidator = z.infer<typeof validatorSchema>;
export type ValidatedUnstakingEntry = z.infer<typeof unstakingEntrySchema>;
export type ValidatedFeeEntry = z.infer<typeof feeEntrySchema>;
export type ValidatedStakedHolders = z.infer<typeof stakedHoldersSchema>;
export type ValidatedAuctionInfo = z.infer<typeof auctionInfoSchema>;
