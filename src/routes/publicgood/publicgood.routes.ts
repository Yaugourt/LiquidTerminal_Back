import express, { Request, Response, RequestHandler, NextFunction } from 'express';
import { PublicGoodService } from '../../services/publicgood/publicgood.service';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import { publicGoodCreateSchema, publicGoodUpdateSchema, publicGoodReviewSchema, publicGoodQuerySchema } from '../../schemas/publicgood.schema';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { PublicGoodError } from '../../errors/publicgood.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireModerator } from '../../middleware/roleMiddleware';
import { 
  uploadPublicGoodFilesR2, 
  handlePublicGoodUploadErrorR2, 
  validateAndUploadPublicGoodToR2, 
  getPublicGoodUploadedUrls 
} from '../../middleware/publicgood-upload-r2.middleware';
import { prisma } from '../../core/prisma.service';

const router = express.Router();
const publicGoodService = new PublicGoodService();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

// ========== ROUTE 1: GET /publicgoods - Liste paginée avec filtres ==========
router.get('/', (async (req: Request, res: Response) => {
  try {
    const publicGoods = await publicGoodService.getAll(req.query);
    res.json({
      success: true,
      data: publicGoods.data,
      pagination: publicGoods.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching public goods:', { error, query: req.query });
    if (error instanceof PublicGoodError) {
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

// ========== ROUTE 8: GET /publicgoods/pending - Liste des projets en attente (MODERATOR only) ==========
router.get('/pending', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const publicGoods = await publicGoodService.getPending(req.query);
    res.json({
      success: true,
      data: publicGoods.data,
      pagination: publicGoods.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching pending public goods:', { error, query: req.query });
    if (error instanceof PublicGoodError) {
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

// ========== ROUTE 3: GET /publicgoods/my-submissions - Projets de l'user connecté ==========
router.get('/my-submissions', validatePrivyToken, (async (req: Request, res: Response) => {
  try {
    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'User not authenticated', 
        code: 'UNAUTHENTICATED' 
      });
    }

    // Récupérer l'utilisateur depuis la DB
    const user = await prisma.user.findUnique({ where: { privyUserId } });
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        error: 'User not found', 
        code: 'USER_NOT_FOUND' 
      });
    }

    const publicGoods = await publicGoodService.getBySubmitter(user.id, req.query);
    res.json({
      success: true,
      data: publicGoods.data,
      pagination: publicGoods.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching user public goods:', { error, privyUserId: req.user?.sub });
    if (error instanceof PublicGoodError) {
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

// ========== ROUTE 2: GET /publicgoods/:id - Détail d'un projet ==========
router.get('/:id', (async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid ID format', 
        code: 'INVALID_ID_FORMAT' 
      });
    }

    const publicGood = await publicGoodService.getById(id);
    res.json({
      success: true,
      data: publicGood
    });
  } catch (error) {
    logDeduplicator.error('Error fetching public good:', { error, id: req.params.id });
    if (error instanceof PublicGoodError) {
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

// ========== ROUTE 4: POST /publicgoods - Créer un projet avec upload (R2) ==========
router.post('/', 
  validatePrivyToken,
  uploadPublicGoodFilesR2,
  handlePublicGoodUploadErrorR2,
  validateAndUploadPublicGoodToR2,
  // Parser les JSON strings avant validation
  (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parser targetUsers si c'est une string JSON
      if (typeof req.body.targetUsers === 'string') {
        req.body.targetUsers = JSON.parse(req.body.targetUsers);
      }
      
      // Parser technologies si c'est une string JSON
      if (typeof req.body.technologies === 'string') {
        req.body.technologies = JSON.parse(req.body.technologies);
      }
      
      // Parser supportTypes si c'est une string JSON
      if (req.body.supportTypes && typeof req.body.supportTypes === 'string') {
        req.body.supportTypes = JSON.parse(req.body.supportTypes);
      }
      
      // Parser contributorTypes si c'est une string JSON
      if (req.body.contributorTypes && typeof req.body.contributorTypes === 'string') {
        req.body.contributorTypes = JSON.parse(req.body.contributorTypes);
      }
      
      // Parser screenshots si c'est une string JSON
      if (req.body.screenshots && typeof req.body.screenshots === 'string') {
        req.body.screenshots = JSON.parse(req.body.screenshots);
      }
      
      next();
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON format in request body',
        code: 'INVALID_JSON_FORMAT'
      });
    }
  },
  validateRequest(publicGoodCreateSchema),
  (async (req: Request, res: Response) => {
    try {
      const privyUserId = req.user?.sub;
      if (!privyUserId) {
        return res.status(401).json({ 
          success: false, 
          error: 'User not authenticated', 
          code: 'UNAUTHENTICATED' 
        });
      }

      // Récupérer l'utilisateur depuis la DB
      const user = await prisma.user.findUnique({ where: { privyUserId } });
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          error: 'User not found', 
          code: 'USER_NOT_FOUND' 
        });
      }

      // Récupérer les URLs R2 des fichiers uploadés
      const uploadedFiles = getPublicGoodUploadedUrls(req);
      
      // Merger les URLs des fichiers uploadés avec le body
      const createData = {
        ...req.body,
        submitterId: user.id,
        ...(uploadedFiles.logo && { logo: uploadedFiles.logo }),
        ...(uploadedFiles.banner && { banner: uploadedFiles.banner }),
        ...(uploadedFiles.screenshots && { screenshots: uploadedFiles.screenshots })
      };

      logDeduplicator.info('Files uploaded to R2 successfully', uploadedFiles);

      const publicGood = await publicGoodService.create(createData);
      res.status(201).json({
        success: true,
        message: 'Project submitted successfully',
        data: publicGood
      });
    } catch (error) {
      logDeduplicator.error('Error creating public good:', { error, body: req.body });
      
      if (error instanceof PublicGoodError) {
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

// ========== ROUTE 5: PUT /publicgoods/:id - Modifier un projet avec upload (R2) ==========
router.put('/:id',
  validatePrivyToken,
  uploadPublicGoodFilesR2,
  handlePublicGoodUploadErrorR2,
  validateAndUploadPublicGoodToR2,
  // Parser les JSON strings avant validation
  (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parser targetUsers si c'est une string JSON
      if (typeof req.body.targetUsers === 'string') {
        req.body.targetUsers = JSON.parse(req.body.targetUsers);
      }
      
      // Parser technologies si c'est une string JSON
      if (typeof req.body.technologies === 'string') {
        req.body.technologies = JSON.parse(req.body.technologies);
      }
      
      // Parser supportTypes si c'est une string JSON
      if (req.body.supportTypes && typeof req.body.supportTypes === 'string') {
        req.body.supportTypes = JSON.parse(req.body.supportTypes);
      }
      
      // Parser contributorTypes si c'est une string JSON
      if (req.body.contributorTypes && typeof req.body.contributorTypes === 'string') {
        req.body.contributorTypes = JSON.parse(req.body.contributorTypes);
      }
      
      // Parser screenshots si c'est une string JSON
      if (req.body.screenshots && typeof req.body.screenshots === 'string') {
        req.body.screenshots = JSON.parse(req.body.screenshots);
      }
      
      next();
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON format in request body',
        code: 'INVALID_JSON_FORMAT'
      });
    }
  },
  validateRequest(publicGoodUpdateSchema),
  (async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid ID format', 
          code: 'INVALID_ID_FORMAT' 
        });
      }

      const privyUserId = req.user?.sub;
      if (!privyUserId) {
        return res.status(401).json({ 
          success: false, 
          error: 'User not authenticated', 
          code: 'UNAUTHENTICATED' 
        });
      }

      // Récupérer l'utilisateur depuis la DB
      const user = await prisma.user.findUnique({ where: { privyUserId } });
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          error: 'User not found', 
          code: 'USER_NOT_FOUND' 
        });
      }

      // Vérifier ownership (owner OU ADMIN)
      await publicGoodService.checkOwnership(id, user.id, user.role);

      // Récupérer les URLs R2 des fichiers uploadés
      const uploadedFiles = getPublicGoodUploadedUrls(req);
      
      // Merger les URLs des fichiers uploadés avec le body
      const updateData = {
        ...req.body,
        ...(uploadedFiles.logo && { logo: uploadedFiles.logo }),
        ...(uploadedFiles.banner && { banner: uploadedFiles.banner }),
        ...(uploadedFiles.screenshots && { screenshots: uploadedFiles.screenshots })
      };

      const publicGood = await publicGoodService.update(id, updateData);
      res.json({
        success: true,
        message: 'Project updated successfully',
        data: publicGood
      });
    } catch (error) {
      logDeduplicator.error('Error updating public good:', { error, id: req.params.id, body: req.body });
      
      if (error instanceof PublicGoodError) {
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

// ========== ROUTE 6: DELETE /publicgoods/:id - Supprimer un projet ==========
router.delete('/:id', validatePrivyToken, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid ID format', 
        code: 'INVALID_ID_FORMAT' 
      });
    }

    const privyUserId = req.user?.sub;
    if (!privyUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'User not authenticated', 
        code: 'UNAUTHENTICATED' 
      });
    }

    // Récupérer l'utilisateur depuis la DB
    const user = await prisma.user.findUnique({ where: { privyUserId } });
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        error: 'User not found', 
        code: 'USER_NOT_FOUND' 
      });
    }

    // Vérifier ownership (owner OU ADMIN)
    await publicGoodService.checkOwnership(id, user.id, user.role);

    await publicGoodService.delete(id);
    res.json({ 
      success: true,
      message: 'Project deleted successfully' 
    });
  } catch (error) {
    logDeduplicator.error('Error deleting public good:', { error, id: req.params.id });
    
    if (error instanceof PublicGoodError) {
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

// ========== ROUTE 7: PATCH /publicgoods/:id/review - Review un projet (MODERATOR only) ==========
router.patch('/:id/review', 
  validatePrivyToken, 
  requireModerator,
  validateRequest(publicGoodReviewSchema),
  (async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid ID format', 
          code: 'INVALID_ID_FORMAT' 
        });
      }

      const privyUserId = req.user?.sub;
      if (!privyUserId) {
        return res.status(401).json({ 
          success: false, 
          error: 'User not authenticated', 
          code: 'UNAUTHENTICATED' 
        });
      }

      // Récupérer l'utilisateur depuis la DB
      const user = await prisma.user.findUnique({ where: { privyUserId } });
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          error: 'User not found', 
          code: 'USER_NOT_FOUND' 
        });
      }

      const { status, reviewNotes } = req.body;
      const publicGood = await publicGoodService.review(id, {
        status,
        reviewerId: user.id,
        reviewNotes
      });

      res.json({
        success: true,
        message: 'Project reviewed successfully',
        data: publicGood
      });
    } catch (error) {
      logDeduplicator.error('Error reviewing public good:', { error, id: req.params.id, body: req.body });
      
      if (error instanceof PublicGoodError) {
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

export default router;

