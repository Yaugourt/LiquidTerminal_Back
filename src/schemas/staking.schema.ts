import { z } from 'zod';

export const stakedHoldersQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => val ? parseInt(val, 10) : 1)
    .refine((val) => val >= 1, {
      message: 'Page must be greater than 0'
    }),
  limit: z
    .string()
    .optional()
    .transform((val) => val ? parseInt(val, 10) : 100)
    .refine((val) => val >= 1 && val <= 1000, {
      message: 'Limit must be between 1 and 1000'
    })
});

export const holderAddressParamSchema = z.object({
  address: z
    .string()
    .min(1, 'Address is required')
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
});

export const topHoldersQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => val ? parseInt(val, 10) : 10)
    .refine((val) => val >= 1 && val <= 100, {
      message: 'Limit must be between 1 and 100'
    })
});

/**
 * Schémas GET spécifiques pour les routes de staking
 */

// Schéma pour les validateurs avec sortBy
export const validatorsGetSchema = z.object({
  query: z.object({
    sortBy: z.enum(['stake', 'apr']).optional().default('stake')
  }),
  params: z.object({})
});

// Schéma pour les validations avec pagination
export const validationsGetSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50)
  }),
  params: z.object({})
});

// Schéma pour les trending validators avec sortBy
export const trendingValidatorsGetSchema = z.object({
  query: z.object({
    sortBy: z.enum(['stake', 'apr']).optional().default('stake')
  }),
  params: z.object({})
});

// Schéma pour GET /staking/holders (page >= 1, limit 1..1000; entiers uniquement)
export const stakedHoldersGetSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(1000).optional().default(20)
  }),
  params: z.object({})
});

// Schéma pour GET /staking/holders/top (limit 1..100)
export const topHoldersGetSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(10)
  }),
  params: z.object({})
});

// Schéma pour les routes sans query params
export const stakingStatsGetSchema = z.object({
  query: z.object({}),
  params: z.object({})
});

// Schéma pour les routes avec address param
export const holderByAddressGetSchema = z.object({
  query: z.object({}),
  params: z.object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
  })
});

export type StakedHoldersQueryInput = z.infer<typeof stakedHoldersQuerySchema>;
export type HolderAddressParamInput = z.infer<typeof holderAddressParamSchema>;
export type TopHoldersQueryInput = z.infer<typeof topHoldersQuerySchema>; 