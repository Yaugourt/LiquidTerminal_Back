import { z } from 'zod';

/**
 * Schéma de validation pour les requêtes de marchés perp (GET)
 */
export const marketPerpGetSchema = z.object({
  query: z.object({
    token: z.string().optional(),
    pair: z.string().optional(),
    sortBy: z.enum(['volume', 'openInterest', 'change24h', 'name', 'price']).optional().default('volume'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    limit: z.string().regex(/^\d+$/).transform(Number).refine(val => val > 0 && val <= 1000, {
      message: 'Limit must be between 1 and 1000'
    }).optional().default(20),
    page: z.string().regex(/^\d+$/).transform(Number).refine(val => val >= 1, {
      message: 'Page must be greater than or equal to 1'
    }).optional().default(1),
  }),
  params: z.object({}),
});

/**
 * Schéma de validation pour les requêtes de marchés perp (avec body pour POST/PUT)
 */
export const marketPerpQuerySchema = z.object({
  query: z.object({
    token: z.string().optional(),
    pair: z.string().optional(),
    sortBy: z.enum(['volume', 'openInterest', 'change24h', 'name', 'price']).optional().default('volume'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    limit: z.string().regex(/^\d+$/).transform(Number).refine(val => val > 0 && val <= 1000, {
      message: 'Limit must be between 1 and 1000'
    }).optional().default(20),
    page: z.string().regex(/^\d+$/).transform(Number).refine(val => val >= 1, {
      message: 'Page must be greater than or equal to 1'
    }).optional().default(1),
  }),
  params: z.object({}),
  body: z.object({})
});

/**
 * Schéma de validation pour les requêtes de statistiques globales perp (GET)
 */
export const globalPerpStatsGetSchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

/**
 * Schéma de validation pour les requêtes de statistiques globales perp (avec body pour POST/PUT)
 */
export const globalPerpStatsQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
  body: z.object({})
}); 