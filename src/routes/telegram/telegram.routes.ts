import { Router, Request, Response, RequestHandler } from 'express';
import { TelegramService } from '../../services/telegram/telegram.service';
import { TelegramWalletSubscriptionService } from '../../services/telegram/telegram.wallet-subscription.service';
import { TelegramError } from '../../errors/telegram.errors';
import { validateTelegramBotApiKey } from '../../middleware/telegramBotAuth.middleware';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import {
  telegramIdQuerySchema,
  telegramWalletListItemsSchema,
  createWalletSubscriptionSchema,
  updateWalletSubscriptionSchema,
  walletSubscriptionQuerySchema,
  walletSubscriptionByIdSchema,
} from '../../schemas/telegram.schema';
import { WalletEventType } from '@prisma/client';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const telegramService = TelegramService.getInstance();
const walletSubService = TelegramWalletSubscriptionService.getInstance();

/**
 * GET /telegram/account?telegramId=XXX
 * Check if a Telegram user is linked to a LiquidTerminal account.
 * Used by bot on /start.
 */
router.get('/account',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(telegramIdQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const telegramId = BigInt(req.query.telegramId as string);

      logDeduplicator.info('GET /telegram/account', { telegramId: telegramId.toString() });

      const account = await telegramService.getLinkedAccount(telegramId);

      res.json({
        success: true,
        data: account,
      });
    } catch (error) {
      logDeduplicator.error('Error checking telegram account:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          code: error.code,
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }) as RequestHandler
);

/**
 * GET /telegram/wallets?telegramId=XXX
 * Get wallets of the linked LiquidTerminal user.
 * Used by bot for /wallets command and subscription filtering.
 */
router.get('/wallets',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(telegramIdQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const telegramId = BigInt(req.query.telegramId as string);
      const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;

      logDeduplicator.info('GET /telegram/wallets', { telegramId: telegramId.toString(), page, limit });

      const result = await telegramService.getLinkedWallets(telegramId, page, limit);

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      logDeduplicator.error('Error fetching telegram wallets:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          code: error.code,
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }) as RequestHandler
);

/**
 * GET /telegram/wallet-lists?telegramId=XXX
 * Get wallet lists of the linked LiquidTerminal user.
 * Used by bot for /wallets command.
 */
router.get('/wallet-lists',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(telegramIdQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const telegramId = BigInt(req.query.telegramId as string);

      logDeduplicator.info('GET /telegram/wallet-lists', { telegramId: telegramId.toString() });

      const walletLists = await telegramService.getLinkedWalletLists(telegramId);

      res.json({
        success: true,
        data: walletLists,
      });
    } catch (error) {
      logDeduplicator.error('Error fetching telegram wallet lists:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          code: error.code,
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }) as RequestHandler
);

/**
 * GET /telegram/wallet-lists/:id/items?telegramId=XXX
 * Get items of a specific wallet list for the linked user.
 */
router.get('/wallet-lists/:id/items',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(telegramWalletListItemsSchema),
  (async (req: Request, res: Response) => {
    try {
      const telegramId = BigInt(req.query.telegramId as string);
      const listId = parseInt(String(req.params.id), 10);

      logDeduplicator.info('GET /telegram/wallet-lists/:id/items', {
        telegramId: telegramId.toString(),
        listId,
      });

      const result = await telegramService.getWalletListItems(telegramId, listId);

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      logDeduplicator.error('Error fetching telegram wallet list items:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          code: error.code,
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }) as RequestHandler
);

/**
 * POST /telegram/verify-link
 * Called by bot when user clicks deep link with /start LINK_XXXXX.
 * Bot sends the code + telegramId, backend verifies and links the account.
 */
router.post('/verify-link',
  validateTelegramBotApiKey,
  marketRateLimiter,
  (async (req: Request, res: Response) => {
    try {
      const { code, telegramId, username, firstName } = req.body;

      if (!code || typeof code !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'code is required',
          code: 'INVALID_CODE',
        });
      }

      if (!telegramId || typeof telegramId !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'telegramId is required as a string',
          code: 'INVALID_TELEGRAM_ID',
        });
      }

      let telegramIdBigInt: bigint;
      try {
        telegramIdBigInt = BigInt(telegramId);
        if (telegramIdBigInt <= 0n) throw new Error();
      } catch {
        return res.status(400).json({
          success: false,
          message: 'telegramId must be a valid positive numeric ID',
          code: 'INVALID_TELEGRAM_ID',
        });
      }

      logDeduplicator.info('POST /telegram/verify-link', {
        code,
        telegramId,
      });

      const result = await telegramService.verifyLinkCode(
        code,
        telegramIdBigInt,
        username || undefined,
        firstName || undefined,
      );

      res.json({
        success: true,
        message: 'Account linked successfully',
        data: { userId: result.userId },
      });
    } catch (error) {
      logDeduplicator.error('Error verifying telegram link:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          code: error.code,
        });
      }

      res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }) as RequestHandler
);

// ==================== WALLET SUBSCRIPTIONS ====================

/**
 * GET /telegram/wallet-subscriptions?telegramId=XXX
 * List all wallet tracking subscriptions for a user.
 */
router.get('/wallet-subscriptions',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(walletSubscriptionQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      const telegramId = BigInt(req.query.telegramId as string);
      logDeduplicator.info('GET /telegram/wallet-subscriptions', { telegramId: telegramId.toString() });
      const data = await walletSubService.list(telegramId);
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('Error listing wallet subscriptions:', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
      }
      res.status(500).json({ success: false, message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    }
  }) as RequestHandler
);

/**
 * POST /telegram/wallet-subscriptions
 * Create a new wallet tracking subscription.
 * Body: { telegramId, name, walletAddresses?, useLinkedWallets?, eventTypes?, minAmountUsd? }
 */
router.post('/wallet-subscriptions',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(createWalletSubscriptionSchema),
  (async (req: Request, res: Response) => {
    try {
      const { telegramId, name, walletAddresses, useLinkedWallets, eventTypes, minAmountUsd } = req.body;
      logDeduplicator.info('POST /telegram/wallet-subscriptions', { telegramId, name });
      const data = await walletSubService.create({
        telegramId: BigInt(telegramId),
        name,
        walletAddresses,
        useLinkedWallets,
        eventTypes: eventTypes as WalletEventType[] | undefined,
        minAmountUsd,
      });
      res.status(201).json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('Error creating wallet subscription:', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
      }
      res.status(500).json({ success: false, message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    }
  }) as RequestHandler
);

/**
 * PUT /telegram/wallet-subscriptions/:id
 * Update a wallet tracking subscription (name, filters, isActive toggle).
 * Body: { telegramId, name?, walletAddresses?, useLinkedWallets?, eventTypes?, minAmountUsd?, isActive? }
 */
router.put('/wallet-subscriptions/:id',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(updateWalletSubscriptionSchema),
  (async (req: Request, res: Response) => {
    try {
      const subscriptionId = String(req.params.id);
      const { telegramId, name, walletAddresses, useLinkedWallets, eventTypes, minAmountUsd, isActive } = req.body;
      logDeduplicator.info('PUT /telegram/wallet-subscriptions/:id', { telegramId, subscriptionId });
      const data = await walletSubService.update({
        telegramId: BigInt(telegramId),
        subscriptionId,
        name,
        walletAddresses,
        useLinkedWallets,
        eventTypes: eventTypes as WalletEventType[] | undefined,
        minAmountUsd,
        isActive,
      });
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('Error updating wallet subscription:', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
      }
      res.status(500).json({ success: false, message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    }
  }) as RequestHandler
);

/**
 * DELETE /telegram/wallet-subscriptions/:id?telegramId=XXX
 * Delete a wallet tracking subscription.
 */
router.delete('/wallet-subscriptions/:id',
  validateTelegramBotApiKey,
  marketRateLimiter,
  validateRequest(walletSubscriptionByIdSchema),
  (async (req: Request, res: Response) => {
    try {
      const telegramId = BigInt(req.query.telegramId as string);
      const subscriptionId = String(req.params.id);
      logDeduplicator.info('DELETE /telegram/wallet-subscriptions/:id', { telegramId: telegramId.toString(), subscriptionId });
      await walletSubService.delete(telegramId, subscriptionId);
      res.json({ success: true, message: 'Subscription deleted' });
    } catch (error) {
      logDeduplicator.error('Error deleting wallet subscription:', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof TelegramError) {
        return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
      }
      res.status(500).json({ success: false, message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    }
  }) as RequestHandler
);

/**
 * GET /telegram/wallet-subscriptions/active
 * Internal route for the bot dispatcher: fetch all active subscriptions
 * with resolved wallet addresses (including linked LT wallets).
 */
router.get('/wallet-subscriptions/active',
  validateTelegramBotApiKey,
  marketRateLimiter,
  (async (_req: Request, res: Response) => {
    try {
      const data = await walletSubService.getActiveSubscriptions();
      res.json({ success: true, data });
    } catch (error) {
      logDeduplicator.error('Error fetching active wallet subscriptions:', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ success: false, message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    }
  }) as RequestHandler
);

export default router;
