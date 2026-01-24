import express, { Request, Response, RequestHandler } from "express";
import { EducationalCategoryService } from "../../services/educational/educational-category.service";
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireModerator, requireAdmin } from '../../middleware/roleMiddleware';
import { validateGetRequest } from '../../middleware/validation';
import {
  validateCreateEducationalCategory,
  validateUpdateEducationalCategory
} from '../../middleware/validation';
import {
  educationalCategoriesGetSchema,
  educationalCategoryByIdGetSchema,
  educationalCategoryResourcesGetSchema
} from '../../schemas/educational.schema';
import { EducationalError } from '../../errors/educational.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const educationalCategoryService = new EducationalCategoryService();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

// Route pour créer une nouvelle catégorie éducative
router.post('/', validatePrivyToken, requireModerator, validateCreateEducationalCategory, (async (req: Request, res: Response) => {
  try {
    const userId = req.currentUser?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
    }

    const categoryData = { ...req.body, createdBy: userId };
    const category = await educationalCategoryService.create(categoryData);
    
    res.status(201).json({
      success: true,
      message: 'Educational category created successfully',
      data: category
    });
  } catch (error) {
    logDeduplicator.error('Error creating educational category:', { error, body: req.body });
    
    if (error instanceof EducationalError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

// Route pour récupérer toutes les catégories éducatives
router.get('/', validateGetRequest(educationalCategoriesGetSchema), (async (req: Request, res: Response) => {
  try {
    const categories = await educationalCategoryService.getAll(req.query);
    res.json({
      success: true,
      data: categories.data,
      pagination: categories.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching educational categories:', { error });
    
    if (error instanceof EducationalError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

// Route pour récupérer une catégorie éducative par son ID
router.get('/:id', validateGetRequest(educationalCategoryByIdGetSchema), (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const category = await educationalCategoryService.getById(id);
    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    logDeduplicator.error('Error fetching educational category:', { error, id: req.params.id });
    
    if (error instanceof EducationalError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

// Route pour récupérer les ressources d'une catégorie
router.get('/:id/resources', validateGetRequest(educationalCategoryResourcesGetSchema), (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const resources = await educationalCategoryService.getResourcesByCategory(id);
    res.json({
      success: true,
      data: resources
    });
  } catch (error) {
    logDeduplicator.error('Error fetching resources by category:', { error, id: req.params.id });
    
    if (error instanceof EducationalError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

// Route pour mettre à jour une catégorie éducative
router.put('/:id', validatePrivyToken, requireModerator, validateUpdateEducationalCategory, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const category = await educationalCategoryService.update(id, req.body);
    res.json({
      success: true,
      message: 'Educational category updated successfully',
      data: category
    });
  } catch (error) {
    logDeduplicator.error('Error updating educational category:', { error, id: req.params.id, body: req.body });
    
    if (error instanceof EducationalError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

// Route pour supprimer une catégorie éducative
router.delete('/:id', validatePrivyToken, requireAdmin, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    await educationalCategoryService.delete(id);
    res.json({
      success: true,
      message: 'Educational category deleted successfully'
    });
  } catch (error) {
    logDeduplicator.error('Error deleting educational category:', { error, id: req.params.id });
    
    if (error instanceof EducationalError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);



export default router; 