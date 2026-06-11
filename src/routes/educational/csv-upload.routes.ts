import express, { Request, Response, RequestHandler } from "express";
import { CsvResourceService } from "../../services/educational/csv-resource.service";
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireModerator } from '../../middleware/roleMiddleware';
import { 
  uploadCsvResources, 
  handleCsvUploadError, 
  validateCsvFile, 
  getCsvFilePath, 
  cleanupCsvFile 
} from '../../middleware/csv-upload.middleware';
import { EducationalError } from '../../errors/educational.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const csvResourceService = new CsvResourceService();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

// Route pour uploader un fichier CSV de ressources éducatives
router.post('/upload', 
  validatePrivyToken, 
  requireModerator, 
  uploadCsvResources,
  handleCsvUploadError,
  validateCsvFile,
  (async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier CSV fourni',
        code: 'NO_FILE_PROVIDED'
      });
    }

    const userId = req.currentUser?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Utilisateur non authentifié',
        code: 'UNAUTHENTICATED'
      });
    }

    try {
      logDeduplicator.info('Starting CSV upload processing', { 
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        userId
      });

      logDeduplicator.info('DEBUG: About to get file path');

      // Obtenir le chemin du fichier
      const filePath = getCsvFilePath(req.file.filename);
      
      logDeduplicator.info('DEBUG: File path obtained', { filePath });

      logDeduplicator.info('DEBUG: About to call csvResourceService.processCsvFile');

      // Traiter le fichier CSV
      const result = await csvResourceService.processCsvFile(filePath, userId);

      // Nettoyer le fichier temporaire
      cleanupCsvFile(filePath);

      logDeduplicator.info('CSV upload processing completed successfully', {
        totalRows: result.totalRows,
        successfulImports: result.successfulImports,
        failedImports: result.failedImports,
        userId
      });

      res.status(200).json({
        success: true,
        message: 'Import CSV terminé avec succès',
        data: {
          totalRows: result.totalRows,
          successfulImports: result.successfulImports,
          failedImports: result.failedImports,
          errors: result.errors,
          createdCategories: result.createdCategories
        }
      });

    } catch (error) {
      // Nettoyer le fichier en cas d'erreur
      if (req.file) {
        cleanupCsvFile(getCsvFilePath(req.file.filename));
      }

      logDeduplicator.error('Error processing CSV upload:', { 
        error, 
        filename: req.file?.filename,
        userId 
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
        error: 'Erreur interne lors du traitement du fichier CSV',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

export default router; 