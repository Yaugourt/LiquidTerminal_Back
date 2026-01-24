import express, { Request, Response, RequestHandler } from "express";
import { LinkPreviewService } from "../../services/linkPreview/linkPreview.service";
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateRequest } from '../../middleware/validation/validation.middleware';
import {
  linkPreviewBatchPostSchema,
  linkPreviewByIdGetSchema,
  linkPreviewListSchema
} from '../../schemas/linkPreview.schema';
import { LinkPreviewError } from '../../errors/linkPreview.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const linkPreviewService = LinkPreviewService.getInstance();

// Rate limiting
router.use(marketRateLimiter);

// POST /api/link-preview/batch - pour plusieurs URLs
router.post('/batch', validateRequest(linkPreviewBatchPostSchema), (async (req: Request, res: Response) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'URLs array is required',
        code: 'MISSING_URLS_ARRAY'
      });
    }

    if (urls.length > 10) {
      return res.status(400).json({ 
        success: false,
        error: 'Maximum 10 URLs per batch',
        code: 'TOO_MANY_URLS'
      });
    }

    const results = await linkPreviewService.generatePreviewsBatch(urls);

    res.json({
      success: true,
      results
    });

  } catch (error) {
    logDeduplicator.error('Batch link preview error:', { error, body: req.body });
    
    if (error instanceof LinkPreviewError) {
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

// GET /api/link-preview/:id
router.get('/:id', validateRequest(linkPreviewByIdGetSchema), (async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ 
        success: false,
        error: 'ID parameter is required',
        code: 'MISSING_ID_PARAMETER'
      });
    }

    const preview = await linkPreviewService.getByIdString(String(id));

    if (!preview) {
      return res.status(404).json({ 
        success: false,
        error: 'Link preview not found',
        code: 'LINK_PREVIEW_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      data: preview
    });

  } catch (error) {
    logDeduplicator.error('Link preview by ID route error:', { error, params: req.params });
    
    if (error instanceof LinkPreviewError) {
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

// GET /api/link-preview - liste des aperçus
router.get('/', validateRequest(linkPreviewListSchema), (async (req: Request, res: Response) => {
  try {
    const previews = await linkPreviewService.getAll(req.query);
    
    res.json({
      success: true,
      data: previews.data,
      pagination: previews.pagination
    });

  } catch (error) {
    logDeduplicator.error('Link preview list route error:', { error, query: req.query });
    
    if (error instanceof LinkPreviewError) {
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