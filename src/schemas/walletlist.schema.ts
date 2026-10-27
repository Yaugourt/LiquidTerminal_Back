import { z } from 'zod';

// Longest wallet list name (the copy name of a long list is trimmed to fit)
export const WALLET_LIST_NAME_MAX = 255;

// Schéma pour la création de WalletList
export const walletListCreateSchema = z.object({
  name: z.string()
    .min(2, 'Le nom doit contenir au moins 2 caractères')
    .max(WALLET_LIST_NAME_MAX, 'Le nom ne doit pas dépasser 255 caractères')
    .trim(),
  description: z.string()
    .max(500, 'La description ne doit pas dépasser 500 caractères')
    .trim()
    .optional(),
  isPublic: z.boolean().optional(),
  userId: z.number().int().positive()
});

// Schéma pour la mise à jour de WalletList
export const walletListUpdateSchema = z.object({
  name: z.string()
    .min(2, 'Le nom doit contenir au moins 2 caractères')
    .max(WALLET_LIST_NAME_MAX, 'Le nom ne doit pas dépasser 255 caractères')
    .trim()
    .optional(),
  description: z.string()
    .max(500, 'La description ne doit pas dépasser 500 caractères')
    .trim()
    .optional(),
  isPublic: z.boolean().optional()
});

// Schéma pour les requêtes de WalletLists
export const walletListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  isPublic: z.coerce.boolean().optional(),
  userId: z.coerce.number().int().positive().optional()
});

// Schéma pour la création de WalletListItem
export const walletListItemCreateSchema = z.object({
  userWalletId: z.number().int().positive(),
  walletListId: z.number().int().positive().optional(),
  notes: z.string()
    .max(1000, 'Les notes ne doivent pas dépasser 1000 caractères')
    .trim()
    .optional(),
  order: z.number().int().min(0).optional()
});

// Schéma pour la mise à jour de WalletListItem
export const walletListItemUpdateSchema = z.object({
  notes: z.string()
    .max(1000, 'Les notes ne doivent pas dépasser 1000 caractères')
    .trim()
    .optional(),
  order: z.number().int().min(0).optional()
});

// Schéma pour les requêtes de WalletListItems
export const walletListItemQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  walletListId: z.coerce.number().int().positive().optional()
});

// Types
export type WalletListCreateInput = z.infer<typeof walletListCreateSchema>;
export type WalletListUpdateInput = z.infer<typeof walletListUpdateSchema>;
export type WalletListItemCreateInput = z.infer<typeof walletListItemCreateSchema>;
export type WalletListItemUpdateInput = z.infer<typeof walletListItemUpdateSchema>;
