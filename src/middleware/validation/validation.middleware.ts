import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodObject, ZodError } from 'zod';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Middleware de validation générique utilisant Zod
 * @param schema Schéma Zod pour valider la requête
 * @param validateCacheKey Clé de cache optionnelle pour stocker les résultats de validation
 * @param cacheTTL Durée de vie du cache en secondes (par défaut: 300 secondes / 5 minutes)
 */
export const validateRequest = (
  schema: ZodObject<any>,
  validateCacheKey?: string,
  cacheTTL: number = 300
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Vérifier si nous avons un cache de validation
      if (validateCacheKey && redisService) {
        const cacheKey = `validation:${validateCacheKey}:${req.originalUrl}`;
        const cachedValidation = await redisService.get(cacheKey);
        
        if (cachedValidation) {
          // Si la validation est en cache et valide, on continue
          next();
          return;
        }
      }

      // Valider la requête avec le schéma Zod
      const parsed = (await schema.parseAsync({
        body: req.body,        // ✅ Pas de double wrapping !
        query: req.query,      // ✅ Pas de double wrapping !
        params: req.params,    // ✅ Pas de double wrapping !
      })) as { body?: unknown };

      // Remplacer le body brut par le body validé+strippé par Zod : les clés
      // inconnues (ex. un `status`/`role` smuggle) ne peuvent plus atteindre un
      // handler qui spread req.body vers un service/écriture DB. Seul le body est
      // réassigné — req.query est en lecture seule sous Express 5.
      if (parsed.body !== undefined) {
        req.body = parsed.body;
      }

      // Si la validation réussit et qu'on a une clé de cache, on met en cache
      if (validateCacheKey && redisService) {
        const cacheKey = `validation:${validateCacheKey}:${req.originalUrl}`;
        await redisService.set(cacheKey, 'valid', cacheTTL);
      }

      // Continuer vers le prochain middleware
      next();
    } catch (error) {
      // Gérer les erreurs de validation Zod
      if (error instanceof ZodError) {
        const errors = error.issues.map((err: any) => ({
          path: err.path.join('.'),
          message: err.message,
        }));

        logDeduplicator.error('Validation error:', { 
          path: req.path,
          method: req.method,
          errors 
        });

        res.status(400).json({
          error: 'Validation Error',
          details: errors,
        });
        return;
      }

      // Gérer les autres erreurs
      logDeduplicator.error('Validation middleware error:', { 
        path: req.path,
        method: req.method,
        error: error instanceof Error ? error.message : String(error)
      });

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An error occurred during request validation',
      });
    }
  };
};

/**
 * Middleware de validation pour les paramètres de requête spécifiques
 * @param paramName Nom du paramètre à valider
 * @param validator Fonction de validation personnalisée
 */
export const validateParam = (
  paramName: string,
  validator: (value: any) => boolean
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const value = req.params[paramName];
    
    if (!value) {
      res.status(400).json({
        error: 'Validation Error',
        message: `Missing required parameter: ${paramName}`,
      });
      return;
    }
    
    if (!validator(value)) {
      res.status(400).json({
        error: 'Validation Error',
        message: `Invalid value for parameter: ${paramName}`,
      });
      return;
    }
    
    next();
  };
};

/**
 * Middleware de validation pour les corps de requête
 * @param validator Fonction de validation personnalisée
 */
export const validateBody = (
  validator: (body: any) => { isValid: boolean; errors?: string[] }
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { isValid, errors } = validator(req.body);
    
    if (!isValid) {
      res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid request body',
        details: errors,
      });
      return;
    }
    
    next();
  };
}; 

/**
 * Middleware de validation spécifique pour les routes GET
 * Ne valide que les query params et les params de route, ignore le body
 * @param schema Schéma Zod pour valider la requête GET (query et params uniquement)
 * @param validateCacheKey Clé de cache optionnelle pour stocker les résultats de validation
 * @param cacheTTL Durée de vie du cache en secondes (par défaut: 300 secondes / 5 minutes)
 */
export const validateGetRequest = (
  schema: ZodObject<any>,
  validateCacheKey?: string,
  cacheTTL: number = 300
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Vérifier si nous avons un cache de validation
      if (validateCacheKey && redisService) {
        const cacheKey = `validation:${validateCacheKey}:${req.originalUrl}`;
        const cachedValidation = await redisService.get(cacheKey);
        
        if (cachedValidation) {
          // Si la validation est en cache et valide, on continue
          next();
          return;
        }
      }

      // Valider seulement query et params pour les routes GET
      await schema.parseAsync({
        query: req.query,
        params: req.params,
      });

      // Si la validation réussit et qu'on a une clé de cache, on met en cache
      if (validateCacheKey && redisService) {
        const cacheKey = `validation:${validateCacheKey}:${req.originalUrl}`;
        await redisService.set(cacheKey, 'valid', cacheTTL);
      }

      // Continuer vers le prochain middleware
      next();
    } catch (error) {
      // Gérer les erreurs de validation Zod
      if (error instanceof ZodError) {
        const errors = error.issues.map((err: any) => ({
          path: err.path.join('.'),
          message: err.message,
        }));

        logDeduplicator.error('GET request validation error:', { 
          path: req.path,
          method: req.method,
          errors 
        });

        res.status(400).json({
          error: 'Validation Error',
          details: errors,
        });
        return;
      }

      // Gérer les autres erreurs
      logDeduplicator.error('GET validation middleware error:', { 
        path: req.path,
        method: req.method,
        error: error instanceof Error ? error.message : String(error)
      });

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An error occurred during request validation',
      });
    }
  };
}; 