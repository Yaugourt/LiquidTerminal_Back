import { Request, Response, NextFunction } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';
import { matchesAnyKey } from '../utils/constant-time-compare';

/** Reject absurdly short keys at boot rather than trusting a weak secret. */
const MIN_BOT_KEY_LENGTH = 24;

declare global {
  namespace Express {
    interface Request {
      telegramBot?: {
        authenticated: boolean;
      };
    }
  }
}

/**
 * Middleware to validate Telegram Bot API Key
 * The bot must send: Authorization: Bot <TELEGRAM_BOT_API_KEY>
 * 
 * This protects the telegram routes from unauthorized access.
 * Only the bot should be able to query user data by telegramId.
 */
export const validateTelegramBotApiKey = (req: Request, res: Response, next: NextFunction): void => {
  const validKeys = [
    process.env.TELEGRAM_BOT_API_KEY,
    process.env.TELEGRAM_BOT_API_KEY_SECONDARY,
  ].filter((k): k is string => k != null && k.length >= MIN_BOT_KEY_LENGTH);

  if (validKeys.length === 0) {
    logDeduplicator.error('TELEGRAM_BOT_API_KEY not configured or too short');
    res.status(500).json({
      success: false,
      message: 'Server configuration error',
      code: 'CONFIG_ERROR',
    });
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bot ')) {
    res.status(401).json({
      success: false,
      message: 'Bot API key required (Authorization: Bot <key>)',
      code: 'MISSING_BOT_KEY',
    });
    return;
  }

  const providedKey = authHeader.slice(4); // Remove 'Bot ' prefix

  // Constant-time comparison: Array.includes short-circuits on the first
  // differing byte, leaking a timing oracle that can recover the key byte by byte.
  if (!matchesAnyKey(providedKey, validKeys)) {
    logDeduplicator.warn('Invalid Telegram Bot API key attempt', {
      ip: req.ip,
      path: req.path,
    });
    res.status(403).json({
      success: false,
      message: 'Invalid API key',
      code: 'INVALID_BOT_KEY',
    });
    return;
  }

  req.telegramBot = { authenticated: true };
  next();
};
