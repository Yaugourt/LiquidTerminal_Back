import { Request, Response, NextFunction } from 'express';
import {
  walletListCreateSchema,
  walletListUpdateSchema,
  walletListItemCreateSchema,
  walletListItemUpdateSchema,
  walletListQuerySchema,
  walletListItemQuerySchema
} from '../../schemas/walletlist.schema';

// WalletList validation middleware
export const validateCreateWalletList = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletListCreateSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateUpdateWalletList = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletListUpdateSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateWalletListQuery = (req: Request, res: Response, next: NextFunction) => {
  // Pour GET, on valide seulement les query params
  try {
    walletListQuerySchema.parse(req.query);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      code: 'BAD_REQUEST'
    });
  }
};

// WalletListItem validation middleware
export const validateCreateWalletListItem = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletListItemCreateSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

export const validateUpdateWalletListItem = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletListItemUpdateSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateWalletListItemQuery = (req: Request, res: Response, next: NextFunction) => {
  try {
    walletListItemQuerySchema.parse(req.query);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      code: 'BAD_REQUEST'
    });
  }
};
