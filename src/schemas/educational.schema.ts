import { z } from 'zod';

// Schéma de validation pour les URLs éducatives
const educationalUrlSchema = z.string()
  .url('URL invalide')
  .max(500, 'URL trop longue')
  .regex(/^https:\/\//i, 'Seules les URLs HTTPS sont autorisées');

// Schémas de base pour les catégories éducatives
export const educationalCategoryBaseSchema = z.object({
  name: z.string()
    .min(2, 'Le nom doit contenir au moins 2 caractères')
    .max(100, 'Le nom ne doit pas dépasser 100 caractères')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-_:()À-ÿ]+$/, 'Le nom contient des caractères non autorisés'),

  description: z.string()
    .max(255, 'La description ne doit pas dépasser 255 caractères')
    .trim()
    .optional()
});

// Schéma pour la création de catégorie éducative
export const educationalCategoryCreateSchema = z.object({
  ...educationalCategoryBaseSchema.shape,
  createdBy: z.number().int().positive('ID utilisateur invalide')
});

// Schéma pour la mise à jour de catégorie éducative
export const educationalCategoryUpdateSchema = educationalCategoryBaseSchema.partial();

// Schéma pour les requêtes de catégories éducatives (simplifié)
export const educationalCategoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(10),
  sort: z.enum(['createdAt', 'name']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  search: z.string().max(100, 'Terme de recherche trop long').optional()
});

// Schémas de base pour les ressources éducatives
export const educationalResourceBaseSchema = z.object({
  url: educationalUrlSchema
});

// Schéma pour la création de ressource éducative
export const educationalResourceCreateSchema = z.object({
  ...educationalResourceBaseSchema.shape,
  categoryIds: z.array(z.number().int().positive()).optional()
});

// Schéma pour la création de ressource éducative (Service - inclut addedBy)
export const educationalResourceServiceCreateSchema = z.object({
  ...educationalResourceBaseSchema.shape,
  addedBy: z.number().int().positive('ID utilisateur invalide'),
  categoryIds: z.array(z.number().int().positive()).optional()
});

// Schéma pour la mise à jour de ressource éducative
export const educationalResourceUpdateSchema = educationalResourceBaseSchema.partial();

// Schéma pour les requêtes de ressources éducatives (simplifié)
export const educationalResourceQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(10),
  sort: z.enum(['createdAt', 'url']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  search: z.string().max(100, 'Terme de recherche trop long').optional()
});

// Schéma pour assigner une ressource à une catégorie
export const educationalResourceCategoryCreateSchema = z.object({
  resourceId: z.number().int().positive('ID ressource invalide'),
  categoryId: z.number().int().positive('ID catégorie invalide'),
  assignedBy: z.number().int().positive('ID utilisateur invalide').optional()
});

// Schémas pour les routes Express (avec params, body, query)
export const createEducationalCategorySchema = z.object({
  body: educationalCategoryCreateSchema,
  params: z.object({}),
  query: z.object({})
});

export const updateEducationalCategorySchema = z.object({
  body: educationalCategoryUpdateSchema,
  params: z.object({
    id: z.string().transform(val => parseInt(val))
  }),
  query: z.object({})
});

export const createEducationalResourceSchema = z.object({
  body: educationalResourceCreateSchema,
  params: z.object({}),
  query: z.object({})
});

export const updateEducationalResourceSchema = z.object({
  body: educationalResourceUpdateSchema,
  params: z.object({
    id: z.string().transform(val => parseInt(val))
  }),
  query: z.object({})
});

export const assignResourceToCategorySchema = z.object({
  body: educationalResourceCategoryCreateSchema,
  params: z.object({}),
  query: z.object({})
});

// Schémas pour les routes avec query params
export const getEducationalCategoriesSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: educationalCategoryQuerySchema
});

export const getEducationalResourcesSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: educationalResourceQuerySchema
});

/**
 * Schémas GET spécifiques (sans validation de body)
 */
export const educationalCategoriesGetSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(10),
    sort: z.enum(['createdAt', 'name']).optional().default('createdAt'),
    order: z.enum(['asc', 'desc']).optional().default('desc'),
    search: z.string().max(100, 'Terme de recherche trop long').optional()
  }),
  params: z.object({})
});

export const educationalResourcesGetSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(10),
    sort: z.enum(['createdAt', 'url']).optional().default('createdAt'),
    order: z.enum(['asc', 'desc']).optional().default('desc'),
    search: z.string().max(100, 'Terme de recherche trop long').optional()
  }),
  params: z.object({})
});

export const educationalCategoryByIdGetSchema = z.object({
  query: z.object({}),
  params: z.object({
    id: z.string().transform(val => parseInt(val))
  })
});

export const educationalResourceByIdGetSchema = z.object({
  query: z.object({}),
  params: z.object({
    id: z.string().transform(val => parseInt(val))
  })
});

export const educationalResourcesByCategoryGetSchema = z.object({
  query: z.object({}),
  params: z.object({
    categoryId: z.string().transform(val => parseInt(val))
  })
});

export const educationalCategoryResourcesGetSchema = z.object({
  query: z.object({}),
  params: z.object({
    id: z.string().transform(val => parseInt(val))
  })
});

