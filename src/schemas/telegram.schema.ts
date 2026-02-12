import { z } from 'zod';

/**
 * Schema for Telegram bot routes that require telegramId as query param
 * Usage: GET /telegram/account?telegramId=123456789
 */
export const telegramIdQuerySchema = z.object({
  query: z.object({
    telegramId: z.string({ message: 'telegramId is required' }).refine(
      (val) => {
        try {
          const n = BigInt(val);
          return n > 0n;
        } catch {
          return false;
        }
      },
      { message: 'telegramId must be a valid positive numeric ID' }
    ),
  }),
  params: z.object({}),
});

/**
 * Schema for wallet list items route with telegramId query + id param
 * Usage: GET /telegram/wallet-lists/:id/items?telegramId=123456789
 */
export const telegramWalletListItemsSchema = z.object({
  query: z.object({
    telegramId: z.string({ message: 'telegramId is required' }).refine(
      (val) => {
        try {
          const n = BigInt(val);
          return n > 0n;
        } catch {
          return false;
        }
      },
      { message: 'telegramId must be a valid positive numeric ID' }
    ),
  }),
  params: z.object({
    id: z.string().refine(
      (val) => !isNaN(parseInt(val, 10)) && parseInt(val, 10) > 0,
      { message: 'id must be a valid positive integer' }
    ),
  }),
});

/**
 * Schema for linking a Telegram account from the frontend
 * Usage: POST /auth/link-telegram { telegramUserId: "123456789" }
 */
export const linkTelegramBodySchema = z.object({
  body: z.object({
    telegramUserId: z.string({ message: 'telegramUserId is required' }).refine(
      (val) => {
        try {
          const n = BigInt(val);
          return n > 0n;
        } catch {
          return false;
        }
      },
      { message: 'telegramUserId must be a valid positive numeric ID' }
    ),
  }),
  params: z.object({}),
});
