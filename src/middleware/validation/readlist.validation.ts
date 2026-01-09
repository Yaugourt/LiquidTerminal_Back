import { Request, Response, NextFunction } from 'express';
import {
  readListCreateSchema,
  readListUpdateSchema,
  readListItemCreateSchema,
  readListItemUpdateSchema,
  readListQuerySchema,
  readListItemQuerySchema
} from '../../schemas/readlist.schema';

// ReadList validation middleware
export const validateCreateReadList = (req: Request, res: Response, next: NextFunction) => {
  try {
    readListCreateSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateUpdateReadList = (req: Request, res: Response, next: NextFunction) => {
  try {
    readListUpdateSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateReadListQuery = (req: Request, res: Response, next: NextFunction) => {
  // Pour GET, on valide seulement les query params
  try {
    readListQuerySchema.parse(req.query);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      code: 'BAD_REQUEST'
    });
  }
};

// ReadListItem validation middleware
export const validateCreateReadListItem = (req: Request, res: Response, next: NextFunction) => {
  try {
    readListItemCreateSchema.parse(req.body);
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

export const validateUpdateReadListItem = (req: Request, res: Response, next: NextFunction) => {
  try {
    readListItemUpdateSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid request data',
      code: 'BAD_REQUEST'
    });
  }
};

export const validateReadListItemQuery = (req: Request, res: Response, next: NextFunction) => {
  try {
    readListItemQuerySchema.parse(req.query);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      code: 'BAD_REQUEST'
    });
  }
}; 