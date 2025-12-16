import express, { Request, Response, RequestHandler } from "express";
import { EducationalResourceService } from "../../services/educational/educational-resource.service";
import { resourceReportService } from "../../services/educational/resource-report.service";
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { contributionRateLimiter, recordContribution } from '../../middleware/contributionRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireUser, requireModerator, requireAdmin } from '../../middleware/roleMiddleware';
import { validateGetRequest } from '../../middleware/validation';
import {
  validateCreateEducationalResource,
  validateUpdateEducationalResource,
  validateAssignResourceToCategory,
} from '../../middleware/validation';
import {
  educationalResourcesGetSchema,
  educationalResourceByIdGetSchema,
  educationalResourcesByCategoryGetSchema
} from '../../schemas/educational.schema';
import { EducationalError } from '../../errors/educational.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const educationalResourceService = new EducationalResourceService();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

// Route pour soumettre une nouvelle ressource éducative (tout utilisateur connecté)
// Les ressources seront en attente de modération (status PENDING)
router.post('/', validatePrivyToken, requireUser, contributionRateLimiter, validateCreateEducationalResource, (async (req: Request, res: Response) => {
  try {
    const userId = req.currentUser?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
    }

    const resourceData = { ...req.body, addedBy: userId };
    const resource = await educationalResourceService.submitResource(resourceData);

    // Enregistrer la contribution pour le rate limiting
    await recordContribution(userId);

    res.status(201).json({
      success: true,
      message: 'Resource submitted successfully. It will be reviewed by a moderator.',
      data: resource
    });
  } catch (error) {
    logDeduplicator.error('Error submitting educational resource:', { error, body: req.body });

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

// Route pour récupérer les soumissions de l'utilisateur connecté
router.get('/my-submissions', validatePrivyToken, requireUser, (async (req: Request, res: Response) => {
  try {
    const userId = req.currentUser?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await educationalResourceService.getUserSubmissions(userId, { page, limit });

    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching user submissions:', { error });

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

// Route pour récupérer toutes les ressources éducatives
router.get('/', validateGetRequest(educationalResourcesGetSchema), (async (req: Request, res: Response) => {
  try {
    const resources = await educationalResourceService.getAll(req.query);
    res.json({
      success: true,
      data: resources.data,
      pagination: resources.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching educational resources:', { error });

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

// Route pour récupérer une ressource éducative par son ID
router.get('/:id', validateGetRequest(educationalResourceByIdGetSchema), (async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const resource = await educationalResourceService.getById(id);
    res.json({
      success: true,
      data: resource
    });
  } catch (error) {
    logDeduplicator.error('Error fetching educational resource:', { error, id: req.params.id });

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

// Route pour mettre à jour une ressource éducative
router.put('/:id', validatePrivyToken, requireModerator, validateUpdateEducationalResource, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const resource = await educationalResourceService.update(id, req.body);
    res.json({
      success: true,
      message: 'Educational resource updated successfully',
      data: resource
    });
  } catch (error) {
    logDeduplicator.error('Error updating educational resource:', { error, id: req.params.id, body: req.body });

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

// Route pour supprimer une ressource éducative
router.delete('/:id', validatePrivyToken, requireAdmin, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    await educationalResourceService.delete(id);
    res.json({
      success: true,
      message: 'Educational resource deleted successfully'
    });
  } catch (error) {
    logDeduplicator.error('Error deleting educational resource:', { error, id: req.params.id });

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

// Route pour assigner une ressource à une catégorie
router.post('/:id/categories', validatePrivyToken, requireModerator, validateAssignResourceToCategory, (async (req: Request, res: Response) => {
  try {
    const resourceId = parseInt(req.params.id, 10);
    if (isNaN(resourceId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid resource ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
    }

    const { categoryId } = req.body;
    await educationalResourceService.assignToCategory({
      resourceId,
      categoryId,
      assignedBy: userId
    });

    res.json({
      success: true,
      message: 'Resource assigned to category successfully'
    });
  } catch (error) {
    logDeduplicator.error('Error assigning resource to category:', {
      error,
      resourceId: req.params.id,
      categoryId: req.body.categoryId
    });

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

// Route pour retirer une ressource d'une catégorie
router.delete('/:id/categories/:categoryId', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const resourceId = parseInt(req.params.id, 10);
    const categoryId = parseInt(req.params.categoryId, 10);

    if (isNaN(resourceId) || isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    await educationalResourceService.removeFromCategory(resourceId, categoryId);

    res.json({
      success: true,
      message: 'Resource removed from category successfully'
    });
  } catch (error) {
    logDeduplicator.error('Error removing resource from category:', {
      error,
      resourceId: req.params.id,
      categoryId: req.params.categoryId
    });

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

// Route pour récupérer les ressources d'une catégorie spécifique
router.get('/category/:categoryId', validateGetRequest(educationalResourcesByCategoryGetSchema), (async (req: Request, res: Response) => {
  try {
    const categoryId = parseInt(req.params.categoryId, 10);
    if (isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid category ID format',
        code: 'INVALID_CATEGORY_ID_FORMAT'
      });
    }

    const resources = await educationalResourceService.getResourcesByCategory(categoryId);
    res.json({
      success: true,
      data: resources
    });
  } catch (error) {
    logDeduplicator.error('Error fetching resources by category:', { error, categoryId: req.params.categoryId });

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

// ==================== MODERATION ROUTES (Moderator only) ====================

// Route pour récupérer les ressources en attente de modération
router.get('/moderation/pending', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await educationalResourceService.getPendingResources({ page, limit });

    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching pending resources:', { error });

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

// Route pour compter les ressources en attente
router.get('/moderation/pending/count', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const count = await educationalResourceService.countPending();

    res.json({
      success: true,
      data: { count }
    });
  } catch (error) {
    logDeduplicator.error('Error counting pending resources:', { error });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

// Route pour approuver une ressource
router.patch('/:id/approve', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const reviewerId = req.currentUser?.id;
    if (!reviewerId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
    }

    const { notes } = req.body;
    const resource = await educationalResourceService.approveResource(id, reviewerId, notes);

    res.json({
      success: true,
      message: 'Resource approved successfully',
      data: resource
    });
  } catch (error) {
    logDeduplicator.error('Error approving resource:', { error, id: req.params.id });

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

// Route pour rejeter une ressource
router.patch('/:id/reject', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const reviewerId = req.currentUser?.id;
    if (!reviewerId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
    }

    const { notes } = req.body;
    if (!notes || notes.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Rejection reason is required',
        code: 'REJECTION_REASON_REQUIRED'
      });
    }

    const resource = await educationalResourceService.rejectResource(id, reviewerId, notes);

    res.json({
      success: true,
      message: 'Resource rejected successfully',
      data: resource
    });
  } catch (error) {
    logDeduplicator.error('Error rejecting resource:', { error, id: req.params.id });

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

// ==================== REPORTING ROUTES ====================

// Route pour signaler une ressource (tout utilisateur connecté)
router.post('/:id/report', validatePrivyToken, requireUser, (async (req: Request, res: Response) => {
  try {
    const resourceId = parseInt(req.params.id, 10);
    if (isNaN(resourceId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid resource ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const reportedBy = req.currentUser?.id;
    if (!reportedBy) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
        code: 'UNAUTHENTICATED'
      });
    }

    const { reason } = req.body;
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Report reason is required',
        code: 'REPORT_REASON_REQUIRED'
      });
    }

    if (reason.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Report reason must be 500 characters or less',
        code: 'REPORT_REASON_TOO_LONG'
      });
    }

    const report = await resourceReportService.createReport({
      resourceId,
      reportedBy,
      reason: reason.trim()
    });

    res.status(201).json({
      success: true,
      message: 'Report submitted successfully',
      data: report
    });
  } catch (error) {
    logDeduplicator.error('Error creating report:', { error, resourceId: req.params.id });

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

// Route pour récupérer les signalements (modérateurs uniquement)
router.get('/moderation/reports', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const resourceId = req.query.resourceId ? parseInt(req.query.resourceId as string) : undefined;

    const result = await resourceReportService.getAllReports({ page, limit, resourceId });

    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    logDeduplicator.error('Error fetching reports:', { error });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

// Route pour récupérer les signalements d'une ressource spécifique
router.get('/:id/reports', validatePrivyToken, requireModerator, (async (req: Request, res: Response) => {
  try {
    const resourceId = parseInt(req.params.id, 10);
    if (isNaN(resourceId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid resource ID format',
        code: 'INVALID_ID_FORMAT'
      });
    }

    const reports = await resourceReportService.getReportsForResource(resourceId);

    res.json({
      success: true,
      data: reports
    });
  } catch (error) {
    logDeduplicator.error('Error fetching reports for resource:', { error, resourceId: req.params.id });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

export default router;
