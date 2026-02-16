import { z } from 'zod';

/**
 * Zod schemas for HyperLiquid API responses.
 * The /info endpoint returns different shapes based on the `type` param.
 */

// Asset context for perps
export const perpAssetContextSchema = z.object({
  universe: z.array(z.object({
    name: z.string(),
    szDecimals: z.number(),
  }).passthrough()),
}).passthrough();

// Asset context for spots
export const spotAssetContextSchema = z.array(z.object({
  tokens: z.array(z.object({
    name: z.string(),
    index: z.number(),
  }).passthrough()).optional(),
}).passthrough());

// Global stats
export const globalStatsSchema = z.object({
  totalVlm: z.string().optional(),
  totalNtlPos: z.string().optional(),
}).passthrough();

// Vault response
export const vaultResponseSchema = z.array(z.object({
  name: z.string(),
  vaultAddress: z.string(),
}).passthrough());

export type ValidatedPerpContext = z.infer<typeof perpAssetContextSchema>;
export type ValidatedSpotAssetContext = z.infer<typeof spotAssetContextSchema>;
export type ValidatedGlobalStats = z.infer<typeof globalStatsSchema>;
export type ValidatedVaultResponse = z.infer<typeof vaultResponseSchema>;
