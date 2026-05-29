import { z } from 'zod';

/**
 * Schéma de validation pour les requêtes de vaults (GET)
 */
export const vaultsGetSchema = z.object({
  query: z.object({
    sortBy: z.enum(['apr', 'tvl', 'createTime']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    limit: z.string()
      .transform(Number)
      .refine(n => n > 0 && n <= 10000, 'Limit must be between 1 and 10000')
      .optional(),
    page: z.string()
      .transform(Number)
      .refine(n => n > 0, 'Page must be greater than 0')
      .optional(),
    name: z.string().optional(),
    leader: z.string().optional(),
    isClosed: z.string()
      .transform(val => val === 'true')
      .optional(),
    includeClosed: z.string()
      .transform(val => val === 'true')
      .optional()
  }),
  params: z.object({}),
});

/**
 * Schéma de validation pour les requêtes de vaults (avec body pour POST/PUT)
 */
export const vaultsQuerySchema = z.object({
  query: z.object({
    sortBy: z.enum(['apr', 'tvl', 'createTime']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    limit: z.string()
      .transform(Number)
      .refine(n => n > 0 && n <= 10000, 'Limit must be between 1 and 10000')
      .optional(),
    page: z.string()
      .transform(Number)
      .refine(n => n > 0, 'Page must be greater than 0')
      .optional(),
    name: z.string().optional(),
    leader: z.string().optional(),
    isClosed: z.string()
      .transform(val => val === 'true')
      .optional(),
    includeClosed: z.string()
      .transform(val => val === 'true')
      .optional()
  }),
  params: z.object({}),
  body: z.object({}),
}); 