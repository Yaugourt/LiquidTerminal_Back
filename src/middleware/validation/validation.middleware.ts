import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodObject, ZodError } from 'zod';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Middleware de validation générique utilisant Zod
 * @param schema Schéma Zod pour valider la requête
 *
 * No validation cache: one keyed by URL (the old optional cache key, never
 * used) let every later request to that URL skip validation and the body
 * replacement below, whatever its body.
 */
export const validateRequest = (
  schema: ZodObject<any>
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Valider la requête avec le schéma Zod
      const parsed = (await schema.parseAsync({
        body: req.body,        // ✅ Pas de double wrapping !
        query: req.query,      // ✅ Pas de double wrapping !
        params: req.params,    // ✅ Pas de double wrapping !
      })) as { body?: unknown };

      // Hand the handler the body Zod validated, unknown keys stripped, so a
      // smuggled field (status, reviewerId…) never reaches a handler that
      // spreads req.body into a write. Body only: req.query is a read-only
      // getter in Express 5, and a schema without a body leaves it untouched.
      if (parsed.body !== undefined) {
        req.body = parsed.body;
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
 */
export const validateGetRequest = (
  schema: ZodObject<any>
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Valider seulement query et params pour les routes GET
      await schema.parseAsync({
        query: req.query,
        params: req.params,
      });

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