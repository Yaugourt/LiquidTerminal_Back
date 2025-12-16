import express, { Request, Response, RequestHandler, NextFunction } from "express";
import { ProjectService } from "../../services/project/project.service";
import { validateRequest } from '../../middleware/validation/validation.middleware';
import { projectCategoriesUpdateSchema, projectCreateWithUploadSchema } from '../../schemas/project.schema';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { ProjectNotFoundError, CategoryNotFoundError } from '../../errors/project.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ProjectError } from '../../errors/project.errors';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireModerator, requireAdmin } from '../../middleware/roleMiddleware';
import { uploadProjectFilesR2, validateAndUploadToR2, handleUploadErrorR2, getUploadedUrls } from '../../middleware/upload-r2.middleware';

const router = express.Router();
const projectService = new ProjectService();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

// Route pour créer un nouveau projet avec upload de logo et banner (R2)
router.post('/with-upload', 
  validatePrivyToken, 
  requireModerator, 
  uploadProjectFilesR2,
  handleUploadErrorR2,
  validateAndUploadToR2,
  // Parser les categoryIds avant la validation
  (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parser categoryIds si c'est une string JSON
      if (typeof req.body.categoryIds === 'string') {
        req.body.categoryIds = JSON.parse(req.body.categoryIds);
      }
      next();
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid categoryIds format',
        code: 'INVALID_CATEGORY_IDS'
      });
    }
  },
  validateRequest(projectCreateWithUploadSchema),
  (async (req: Request, res: Response) => {
    try {
      // Récupérer les URLs R2 des fichiers uploadés
      const uploadedFiles = getUploadedUrls(req);
      
      // Ajouter les URLs des fichiers au body
      if (uploadedFiles.logo) {
        req.body.logo = uploadedFiles.logo;
      }
      if (uploadedFiles.banner) {
        req.body.banner = uploadedFiles.banner;
      }

      logDeduplicator.info('Files uploaded to R2 successfully', uploadedFiles);

      const project = await projectService.createWithUpload(req.body);
      res.status(201).json({
        success: true,
        message: 'Project created successfully',
        data: project
      });
    } catch (error) {
      logDeduplicator.error('Error creating project with upload:', { error, body: req.body });
      
      if (error instanceof ProjectError) {
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
  }) as RequestHandler
);

// Route pour créer un nouveau projet (sans upload)
router.post('/', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const project = await projectService.create(req.body);
    res.status(201).json({
      success: true,
      message: 'Project created successfully',
      data: project
    });
  } catch (error) {
    logDeduplicator.error('Error creating project:', { error, body: req.body });
    
    if (error instanceof ProjectError) {
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

// Route pour récupérer tous les projets
router.get('/', (async (req: Request, res: Response) => {
  try {
    const projects = await projectService.getAll(req.query);
    res.json(projects);
  } catch (error) {
    logDeduplicator.error('Error fetching projects:', { error, query: req.query });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

// Route pour récupérer un projet par ID
router.get('/:id', (async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      logDeduplicator.warn('Invalid project ID provided', { id: req.params.id });
      return res.status(400).json({ message: "ID de projet invalide" });
    }
    
    const project = await projectService.getById(projectId);
    if (!project) {
      logDeduplicator.warn('Project not found', { projectId });
      return res.status(404).json({ message: "Projet non trouvé" });
    }
    
    res.json(project);
  } catch (error) {
    logDeduplicator.error('Error fetching project:', { error, projectId: req.params.id });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

// Route pour mettre à jour un projet
router.put('/:id', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      logDeduplicator.warn('Invalid project ID provided', { id: req.params.id });
      return res.status(400).json({ message: "ID de projet invalide" });
    }
    
    const project = await projectService.update(projectId, req.body);
    res.json(project);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      logDeduplicator.warn('Project not found for update', { projectId: req.params.id });
      return res.status(404).json({ message: error.message });
    }
    
    logDeduplicator.error('Error updating project:', { error, projectId: req.params.id, body: req.body });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

// Route pour supprimer un projet
router.delete('/:id', validatePrivyToken, requireAdmin, (async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      logDeduplicator.warn('Invalid project ID provided', { id: req.params.id });
      return res.status(400).json({ message: "ID de projet invalide" });
    }
    
    await projectService.delete(projectId);
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      logDeduplicator.warn('Project not found for deletion', { projectId: req.params.id });
      return res.status(404).json({ message: error.message });
    }
    
    logDeduplicator.error('Error deleting project:', { error, projectId: req.params.id });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

// Route pour assigner des catégories à un projet
router.post('/:id/categories', validatePrivyToken, requireModerator, validateRequest(projectCategoriesUpdateSchema), (async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      logDeduplicator.warn('Invalid project ID provided', { id: req.params.id });
      return res.status(400).json({ message: "ID de projet invalide" });
    }
    
    const { categoryIds } = req.body;
    const project = await projectService.assignCategories(projectId, categoryIds);
    
    if (project) {
      logDeduplicator.info('Project categories assigned successfully', { 
        projectId: project.id,
        title: project.title,
        categoryIds
      });
    }
    
    res.json({
      success: true,
      message: 'Categories assigned successfully',
      data: project
    });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      logDeduplicator.warn('Project not found for category assignment', { projectId: req.params.id });
      return res.status(404).json({ message: error.message });
    }
    
    if (error instanceof CategoryNotFoundError) {
      logDeduplicator.warn('Category not found for project assignment', { 
        projectId: req.params.id,
        categoryIds: req.body.categoryIds
      });
      return res.status(404).json({ message: error.message });
    }
    
    logDeduplicator.error('Error assigning project categories:', { 
      error, 
      projectId: req.params.id,
      categoryIds: req.body.categoryIds
    });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

// Route pour retirer des catégories d'un projet
router.delete('/:id/categories', validatePrivyToken, requireModerator, validateRequest(projectCategoriesUpdateSchema), (async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      logDeduplicator.warn('Invalid project ID provided', { id: req.params.id });
      return res.status(400).json({ message: "ID de projet invalide" });
    }
    
    const { categoryIds } = req.body;
    const project = await projectService.removeCategories(projectId, categoryIds);
    
    if (project) {
      logDeduplicator.info('Project categories removed successfully', { 
        projectId: project.id,
        title: project.title,
        categoryIds
      });
    }
    
    res.json({
      success: true,
      message: 'Categories removed successfully',
      data: project
    });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      logDeduplicator.warn('Project not found for category removal', { projectId: req.params.id });
      return res.status(404).json({ message: error.message });
    }
    
    logDeduplicator.error('Error removing project categories:', { 
      error, 
      projectId: req.params.id,
      categoryIds: req.body.categoryIds
    });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

// Route pour récupérer les catégories d'un projet
router.get('/:id/categories', (async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      logDeduplicator.warn('Invalid project ID provided', { id: req.params.id });
      return res.status(400).json({ message: "ID de projet invalide" });
    }
    
    const categories = await projectService.getProjectCategories(projectId);
    logDeduplicator.info('Project categories retrieved successfully', { 
      projectId,
      count: categories.length
    });
    
    res.json({
      success: true,
      message: 'Project categories retrieved successfully',
      data: categories
    });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      logDeduplicator.warn('Project not found for categories retrieval', { projectId: req.params.id });
      return res.status(404).json({ message: error.message });
    }
    
    logDeduplicator.error('Error fetching project categories:', { 
      error, 
      projectId: req.params.id
    });
    res.status(500).json({ message: 'Internal server error' });
  }
}) as RequestHandler);

export default router; 