import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Middleware pour générer un Request ID unique pour chaque requête
 * Permet le traçage des requêtes dans les logs de bout en bout
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const incomingRequestId = req.header('X-Request-Id');
  const requestId = typeof incomingRequestId === 'string' && incomingRequestId.trim().length > 0
    ? incomingRequestId.trim().slice(0, 128)
    : randomUUID();

  // Attacher le requestId à la requête pour utilisation dans les logs
  req.requestId = requestId;
  
  // Ajouter le Request-ID dans les headers de réponse
  res.setHeader('X-Request-Id', requestId);
  
  next();
};

