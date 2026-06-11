import { Request, Response, NextFunction } from 'express';
import {
  walletCreateSchema,
  walletUpdateSchema,
  walletQuerySchema,
  walletBulkAddSchema,
  walletBulkDeleteSchema
} from '../../schemas/wallet.schema';

// Wallet validation middleware
export const validateCreateWallet = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletCreateSchema.parse(req.body);
    next();
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateUpdateWallet = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletUpdateSchema.parse(req.body);
    next();
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateWalletQuery = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletQuerySchema.parse(req.query);
    next();
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateBulkAddWallet = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletBulkAddSchema.parse(req.body);
    next();
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateBulkDeleteWallet = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletBulkDeleteSchema.parse(req.body);
    next();
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
}; 