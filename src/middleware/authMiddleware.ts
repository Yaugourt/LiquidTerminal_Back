import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth/auth.service';
import { PrivyPayload } from '../types/auth.types';
import { UserRole } from '@prisma/client';
import { TokenValidationError } from '../errors/auth.errors';
import { logDeduplicator } from '../utils/logDeduplicator';

declare global {
  namespace Express {
    interface Request {
      user?: PrivyPayload;
      currentUser?: {
        id: number;
        role: UserRole;
        privyUserId: string;
      };
    }
  }
}

const authService = AuthService.getInstance();

export const validatePrivyToken = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ 
      success: false,
      message: 'Bearer token required',
      code: 'MISSING_TOKEN'
    });
    return;
  }

  const token = authHeader.split(' ')[1];
  authService.verifyToken(token)
    .then(payload => {
      if (!payload.sub) {
        res.status(401).json({ 
          success: false,
          message: 'Invalid token payload',
          code: 'INVALID_PAYLOAD'
        });
        return;
      }
      req.user = payload;
      next();
    })
    .catch(error => {
      logDeduplicator.error('Token validation error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        path: req.path,
        method: req.method
      });
      
      if (error instanceof TokenValidationError) {
        res.status(error.statusCode).json({ 
          success: false,
          message: error.message,
          code: error.code
        });
        return;
      }
      
      res.status(401).json({ 
        success: false,
        message: 'Invalid or expired token',
        code: 'TOKEN_VALIDATION_ERROR'
      });
    });
};

/**
 * Optional authentication: resolves req.user when a valid Bearer token is
 * provided, but lets the request through as anonymous otherwise (missing,
 * malformed or expired token). Use for routes whose visibility depends on
 * the resource (e.g. public read lists readable without an account).
 */
export const optionalPrivyToken = (req: Request, _res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.split(' ')[1];
  authService.verifyToken(token)
    .then(payload => {
      if (payload.sub) {
        req.user = payload;
      }
      next();
    })
    .catch(error => {
      logDeduplicator.warn('Optional token validation failed, continuing as anonymous', {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
        method: req.method
      });
      next();
    });
};