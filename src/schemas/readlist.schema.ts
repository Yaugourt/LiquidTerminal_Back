import { z } from 'zod';

// Longest read list name (the copy name of a long list is trimmed to fit)
export const READ_LIST_NAME_MAX = 255;

// Schéma pour la création de ReadList
export const readListCreateSchema = z.object({
  name: z.string()
    .min(2, 'Le nom doit contenir au moins 2 caractères')
    .max(READ_LIST_NAME_MAX, 'Le nom ne doit pas dépasser 255 caractères')
    .trim(),
  description: z.string()
    .max(500, 'La description ne doit pas dépasser 500 caractères')
    .trim()
    .optional(),
  isPublic: z.boolean().optional(),
  userId: z.number().int().positive()
});

// Schéma pour la mise à jour de ReadList
export const readListUpdateSchema = z.object({
  name: z.string()
    .min(2, 'Le nom doit contenir au moins 2 caractères')
    .max(READ_LIST_NAME_MAX, 'Le nom ne doit pas dépasser 255 caractères')
    .trim()
    .optional(),
  description: z.string()
    .max(500, 'La description ne doit pas dépasser 500 caractères')
    .trim()
    .optional(),
  isPublic: z.boolean().optional()
});

// Schéma pour les requêtes de ReadLists
export const readListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  isPublic: z.coerce.boolean().optional(),
  userId: z.coerce.number().int().positive().optional()
});

// Schéma pour la création de ReadListItem
export const readListItemCreateSchema = z.object({
  resourceId: z.number().int().positive(),
  readListId: z.number().int().positive().optional(),
  notes: z.string()
    .max(1000, 'Les notes ne doivent pas dépasser 1000 caractères')
    .trim()
    .optional(),
  order: z.number().int().min(0).optional(),
  isRead: z.boolean().optional()
});

// Schéma pour la mise à jour de ReadListItem
export const readListItemUpdateSchema = z.object({
  notes: z.string()
    .max(1000, 'Les notes ne doivent pas dépasser 1000 caractères')
    .trim()
    .optional(),
  order: z.number().int().min(0).optional(),
  isRead: z.boolean().optional()
});

// Schéma pour les requêtes de ReadListItems
export const readListItemQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  isRead: z.coerce.boolean().optional(),
  search: z.string().optional()
});

// Types
export type ReadListCreateInput = z.infer<typeof readListCreateSchema>;
export type ReadListUpdateInput = z.infer<typeof readListUpdateSchema>;
export type ReadListItemCreateInput = z.infer<typeof readListItemCreateSchema>;
export type ReadListItemUpdateInput = z.infer<typeof readListItemUpdateSchema>; 