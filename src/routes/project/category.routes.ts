import { Router, Request, Response, RequestHandler } from 'express';
import { CategoryService } from '../../services/project/category.service';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { CategoryNotFoundError, CategoryError } from '../../errors/project.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireModerator, requireAdmin } from '../../middleware/roleMiddleware';

const router = Router();
const categoryService = new CategoryService();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

// GET /api/categories
router.get('/', (async (req: Request, res: Response) => {
  try {
    const categories = await categoryService.getAll(req.query);
    res.json({
      success: true,
      data: categories.data,
      pagination: categories.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching categories:', { error });
    
    if (error instanceof CategoryError) {
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

// Récupérer une catégorie par son ID
router.get('/:id', (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const category = await categoryService.getById(id);
    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    logDeduplicator.error('Error fetching category:', { error, id: req.params.id });
    
    if (error instanceof CategoryError) {
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

// Récupérer une catégorie avec ses projets
router.get('/:id/projects', (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    
    if (isNaN(id)) {
      logDeduplicator.warn('Invalid category ID provided', { id: req.params.id });
      return res.status(400).json({ message: 'ID de catégorie invalide' });
    }
    
    const categoryWithProjects = await categoryService.getCategoryWithProjects(id);
    logDeduplicator.info('Category with projects retrieved successfully', { 
      categoryId: categoryWithProjects.id,
      name: categoryWithProjects.name,
      projectCount: categoryWithProjects.projects.length
    });
    
    res.json(categoryWithProjects);
  } catch (error) {
    if (error instanceof CategoryNotFoundError) {
      logDeduplicator.warn('Category not found', { categoryId: req.params.id });
      return res.status(404).json({ message: error.message });
    }
    
    logDeduplicator.error('Error fetching category with projects:', { error, categoryId: req.params.id });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

// Créer une nouvelle catégorie
router.post('/', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const category = await categoryService.create(req.body);
    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: category
    });
  } catch (error) {
    logDeduplicator.error('Error creating category:', { error, body: req.body });
    
    if (error instanceof CategoryError) {
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

// Mettre à jour une catégorie
router.put('/:id', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const category = await categoryService.update(id, req.body);
    res.json({
      success: true,
      message: 'Category updated successfully',
      data: category
    });
  } catch (error) {
    logDeduplicator.error('Error updating category:', { error, id: req.params.id, body: req.body });
    
    if (error instanceof CategoryError) {
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

// Supprimer une catégorie
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

    await categoryService.delete(id);
    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    logDeduplicator.error('Error deleting category:', { error, id: req.params.id });
    
    if (error instanceof CategoryError) {
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