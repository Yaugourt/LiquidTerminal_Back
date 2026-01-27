import { z } from 'zod';

/**
 * Schéma de validation pour les paramètres de requête de marketSpot (GET)
 */
export const marketSpotGetSchema = z.object({
  query: z.object({
    token: z.string().optional(),
    pair: z.string().optional(),
    sortBy: z.enum(['volume', 'marketCap', 'change24h', 'name', 'price']).optional().default('volume'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    limit: z.string().regex(/^\d+$/).transform(Number).refine(val => val > 0 && val <= 1000, {
      message: 'Limit must be between 1 and 1000'
    }).optional().default(20),
    page: z.string().regex(/^\d+$/).transform(Number).refine(val => val >= 1, {
      message: 'Page must be a positive number (starting from 1)'
    }).optional().default(1),
  }),
  params: z.object({}),
});

/**
 * Schéma de validation pour les paramètres de requête de marketSpot (avec body pour POST/PUT)
 */
export const marketSpotQuerySchema = z.object({
  query: z.object({
    token: z.string().optional(),
    pair: z.string().optional(),
    sortBy: z.enum(['volume', 'marketCap', 'change24h', 'name', 'price']).optional().default('volume'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
    limit: z.string().regex(/^\d+$/).transform(Number).refine(val => val > 0 && val <= 1000, {
      message: 'Limit must be between 1 and 1000'
    }).optional().default(20),
    page: z.string().regex(/^\d+$/).transform(Number).refine(val => val >= 1, {
      message: 'Page must be a positive number (starting from 1)'
    }).optional().default(1),
  }),
  params: z.object({}),
  body: z.object({}),
});

/**
 * Schéma de validation pour les paramètres de requête de globalSpotStats (GET)
 */
export const globalSpotStatsGetSchema = z.object({
  query: z.object({}),
  params: z.object({}),
});

/**
 * Schéma de validation pour les paramètres de requête de globalSpotStats (avec body pour POST/PUT)
 */
export const globalSpotStatsQuerySchema = z.object({
  query: z.object({}),
  params: z.object({}),
  body: z.object({}),
});

/**
 * Schéma de validation pour les paramètres de requête d'auction (GET)
 */
export const auctionGetSchema = z.object({
  query: z.object({
    status: z.enum(['active', 'completed', 'upcoming']).optional(),
    token: z.string().optional(),
  }),
  params: z.object({}),
});

/**
 * Schéma de validation pour les paramètres de requête d'auction (avec body pour POST/PUT)
 */
export const auctionQuerySchema = z.object({
  query: z.object({
    status: z.enum(['active', 'completed', 'upcoming']).optional(),
    token: z.string().optional(),
  }),
  params: z.object({}),
  body: z.object({}),
});

/**
 * Schéma de validation pour la création d'une enchère
 */
export const createAuctionSchema = z.object({
  query: z.object({}),
  params: z.object({}),
  body: z.object({
    token: z.string().min(1, 'Token is required'),
    startPrice: z.number().positive('Start price must be positive'),
    endPrice: z.number().positive('End price must be positive'),
    startTime: z.string().datetime('Invalid start time format'),
    endTime: z.string().datetime('Invalid end time format'),
    description: z.string().optional(),
  }).refine(data => {
    // Vérifier que endTime est après startTime
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);
    return end > start;
  }, {
    message: 'End time must be after start time',
    path: ['endTime'],
  }),
}); 