import express, { Request, Response, RequestHandler } from "express";
import { CsvProjectService } from "../../services/project/csv-project.service";
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { requireModerator } from '../../middleware/roleMiddleware';
import { 
  uploadCsvProjects, 
  handleCsvProjectUploadError, 
  validateCsvProjectFile, 
  getCsvProjectFilePath, 
  cleanupCsvProjectFile 
} from '../../middleware/csv-project-upload.middleware';
import { ProjectError } from '../../errors/project.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const csvProjectService = new CsvProjectService();

// Appliquer le rate limiting à toutes les routes
router.use(marketRateLimiter);

// Route pour uploader un fichier CSV de projets
router.post('/upload', 
  validatePrivyToken, 
  requireModerator, 
  uploadCsvProjects,
  handleCsvProjectUploadError,
  validateCsvProjectFile,
  (async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier CSV fourni',
        code: 'NO_FILE_PROVIDED'
      });
    }

    try {
      logDeduplicator.info('Starting CSV project upload processing', { 
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size
      });

      // Obtenir le chemin du fichier
      const filePath = getCsvProjectFilePath(req.file.filename);
      
      // Traiter le fichier CSV
      const result = await csvProjectService.processCsvFile(filePath);

      // Nettoyer le fichier temporaire
      cleanupCsvProjectFile(filePath);

      logDeduplicator.info('CSV project upload processing completed successfully', {
        totalRows: result.totalRows,
        successfulImports: result.successfulImports,
        failedImports: result.failedImports
      });

      res.status(200).json({
        success: true,
        message: 'Import CSV de projets terminé avec succès',
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
        const filePath = getCsvProjectFilePath(req.file.filename);
        cleanupCsvProjectFile(filePath);
      }

      logDeduplicator.error('Error processing CSV project upload:', { error: error instanceof Error ? error.message : String(error) });
      
      if (error instanceof ProjectError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code
        });
      }

      res.status(500).json({
        success: false,
        error: 'Erreur interne du serveur',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

// Route pour télécharger un template CSV
router.get('/template', (req: Request, res: Response) => {
  const csvTemplate = `title,desc,logo,twitter,discord,telegram,website,Token,category
"Exemple Projet 1","Description du projet exemple avec toutes les fonctionnalités DeFi","https://exemple.com/logo1.png","https://twitter.com/exemple1","https://discord.gg/exemple1","https://t.me/exemple1","https://exemple1.com","EXP1","DeFi"
"Exemple Projet 2","Projet de trading automatisé avec des algorithmes avancés","https://exemple.com/logo2.png","https://twitter.com/exemple2","","https://t.me/exemple2","https://exemple2.com","EXP2","Trading"
"Exemple Projet 3","Plateforme de staking innovante pour plusieurs tokens","https://exemple.com/logo3.png","","https://discord.gg/exemple3","","https://exemple3.com","","Staking"`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="template-projets.csv"');
  res.send(csvTemplate);
});

export default router;
