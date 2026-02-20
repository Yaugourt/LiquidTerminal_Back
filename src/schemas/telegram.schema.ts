import { z } from 'zod';

const WALLET_EVENT_TYPES = ['TRADE', 'ORDER', 'TRANSFER', 'POSITION', 'STAKING'] as const;

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

// ==================== WALLET SUBSCRIPTION SCHEMAS ====================

const telegramIdQuery = z.string({ message: 'telegramId is required' }).refine(
  (val) => {
    try { return BigInt(val) > 0n; } catch { return false; }
  },
  { message: 'telegramId must be a valid positive numeric ID' }
);

/**
 * POST /telegram/wallet-subscriptions
 * Body: { telegramId, name, walletAddresses?, useLinkedWallets?, eventTypes?, minAmountUsd? }
 */
export const createWalletSubscriptionSchema = z.object({
  body: z.object({
    telegramId: z.string().refine(
      (val) => { try { return BigInt(val) > 0n; } catch { return false; } },
      { message: 'telegramId must be a valid positive numeric ID' }
    ),
    name: z.string().min(1).max(100),
    walletAddresses: z.array(
      z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address')
    ).max(50).optional(),
    useLinkedWallets: z.boolean().optional(),
    eventTypes: z.array(z.enum(WALLET_EVENT_TYPES)).optional(),
    minAmountUsd: z.number().min(0).max(10_000_000).optional(),
  }).refine(
    (data) => (data.walletAddresses && data.walletAddresses.length > 0) || data.useLinkedWallets,
    { message: 'At least one wallet address or useLinkedWallets must be set' }
  ),
  params: z.object({}),
});

/**
 * PUT /telegram/wallet-subscriptions/:id
 * Body: { telegramId, name?, walletAddresses?, useLinkedWallets?, eventTypes?, minAmountUsd?, isActive? }
 */
export const updateWalletSubscriptionSchema = z.object({
  body: z.object({
    telegramId: z.string().refine(
      (val) => { try { return BigInt(val) > 0n; } catch { return false; } },
      { message: 'telegramId must be a valid positive numeric ID' }
    ),
    name: z.string().min(1).max(100).optional(),
    walletAddresses: z.array(
      z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address')
    ).max(50).optional(),
    useLinkedWallets: z.boolean().optional(),
    eventTypes: z.array(z.enum(WALLET_EVENT_TYPES)).optional(),
    minAmountUsd: z.number().min(0).max(10_000_000).optional(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().min(1),
  }),
});

/**
 * GET /telegram/wallet-subscriptions?telegramId=XXX
 * DELETE /telegram/wallet-subscriptions/:id?telegramId=XXX
 */
export const walletSubscriptionQuerySchema = z.object({
  query: z.object({ telegramId: telegramIdQuery }),
  params: z.object({}),
});

export const walletSubscriptionByIdSchema = z.object({
  query: z.object({ telegramId: telegramIdQuery }),
  params: z.object({ id: z.string().min(1) }),
});
