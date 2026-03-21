import { Request, Response, NextFunction } from 'express';
import { prisma } from '../core/prisma.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { UserRole } from '@prisma/client';

export const requireRole = (allowedRoles: UserRole[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const privyUserId = req.user?.sub;
      
      if (!privyUserId) {
        logDeduplicator.warn('Role middleware - No privyUserId found', { 
          path: req.path,
          method: req.method 
        });
        res.status(401).json({ 
          success: false, 
          error: 'User not authenticated', 
          code: 'UNAUTHENTICATED' 
        });
        return;
      }

      // Récupérer l'utilisateur avec son rôle
      const user = await prisma.user.findUnique({
        where: { privyUserId },
        select: {
          id: true,
          role: true,
          privyUserId: true
        }
      });

      if (!user) {
        logDeduplicator.warn('Role middleware - User not found in database', { 
          privyUserId,
          path: req.path 
        });
        res.status(401).json({ 
          success: false, 
          error: 'User not found', 
          code: 'USER_NOT_FOUND' 
        });
        return;
      }
      
      if (!allowedRoles.includes(user.role)) {
        logDeduplicator.warn('Role middleware - Insufficient permissions', {
          userId: user.id,
          userRole: user.role,
          requiredRoles: allowedRoles,
          path: req.path,
          method: req.method
        });
        
        res.status(403).json({ 
          success: false, 
          error: 'Insufficient permissions', 
          code: 'INSUFFICIENT_PERMISSIONS' 
        });
        return;
      }

      // Ajouter l'utilisateur à la requête pour éviter de refaire la requête
      req.currentUser = {
        id: user.id,
        role: user.role,
        privyUserId: user.privyUserId
      };
      
      next();
    } catch (error) {
      logDeduplicator.error('Role middleware error', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ 
        success: false, 
        error: 'Authorization error', 
        code: 'AUTHORIZATION_ERROR' 
      });
    }
  };
};

// Middlewares spécialisés pour chaque niveau
export const requireUser = requireRole([UserRole.USER, UserRole.MODERATOR, UserRole.ADMIN]);
export const requireModerator = requireRole([UserRole.MODERATOR, UserRole.ADMIN]);
export const requireAdmin = requireRole([UserRole.ADMIN]); 