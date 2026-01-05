import { parse } from 'csv-parse/sync';
import fs from 'fs';
import { EducationalResourceService } from './educational-resource.service';
import { EducationalCategoryService } from './educational-category.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { EducationalError } from '../../errors/educational.errors';

interface CsvRow {
  Link?: string;
  Category?: string;
  link?: string;
  category?: string;
}

interface CsvProcessingResult {
  totalRows: number;
  successfulImports: number;
  failedImports: number;
  errors: Array<{
    row: number;
    error: string;
    data: CsvRow;
  }>;
  createdCategories: string[];
}

export class CsvResourceService {
  private educationalResourceService: EducationalResourceService;
  private educationalCategoryService: EducationalCategoryService;

  constructor() {
    this.educationalResourceService = new EducationalResourceService();
    this.educationalCategoryService = new EducationalCategoryService();
  }

  /**
   * Traite un fichier CSV et importe les ressources éducatives
   */
  async processCsvFile(filePath: string, userId: number): Promise<CsvProcessingResult> {
    const result: CsvProcessingResult = {
      totalRows: 0,
      successfulImports: 0,
      failedImports: 0,
      errors: [],
      createdCategories: []
    };

    try {
      // Lire le fichier CSV
      const fileContent = fs.readFileSync(filePath, 'utf-8');

      // Parser le CSV
      const records = parse(fileContent, {
        columns: true, // Première ligne comme en-têtes
        skip_empty_lines: true,
        trim: true,
        delimiter: ','
      }) as CsvRow[];

      result.totalRows = records.length;
      
      // Debug: afficher les premières lignes parsées
      logDeduplicator.info('CSV parsed successfully', { 
        totalRows: result.totalRows,
        filePath,
        firstRow: records[0],
        secondRow: records[1]
      });

      logDeduplicator.info('DEBUG: After parsing, before any processing', { 
        recordsLength: records.length,
        resultTotalRows: result.totalRows
      });

      logDeduplicator.info('About to start processing rows', { 
        totalRows: records.length,
        firstRowKeys: Object.keys(records[0])
      });

      logDeduplicator.info('DEBUG: Just before the for loop', { 
        recordsLength: records.length,
        recordsType: typeof records,
        isArray: Array.isArray(records)
      });

      // Traiter chaque ligne
      try {
        for (let i = 0; i < records.length; i++) {
          const row = records[i];
          const rowNumber = i + 2; // +2 car on compte à partir de 1 et on a sauté l'en-tête

          logDeduplicator.info('Starting to process row', { 
            rowNumber, 
            rowData: row,
            rowKeys: Object.keys(row)
          });

          try {
            await this.processRow(row, userId, result);
            result.successfulImports++;
            logDeduplicator.info('Row processed successfully', { rowNumber });
                  } catch (error) {
          result.failedImports++;
          
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : String(error);
          
          result.errors.push({
            row: rowNumber,
            error: errorMessage,
            data: row
          });
          
          logDeduplicator.error('Error processing CSV row', { 
            row: rowNumber, 
            error: errorMessage,
            errorStack: errorStack,
            data: row,
            errorType: error instanceof Error ? error.constructor.name : 'Unknown'
          });
        }
        }
      } catch (error) {
        logDeduplicator.error('Error in main processing loop', { 
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }

      logDeduplicator.info('CSV processing completed', {
        totalRows: result.totalRows,
        successfulImports: result.successfulImports,
        failedImports: result.failedImports,
        createdCategories: result.createdCategories
      });

      return result;

    } catch (error) {
      logDeduplicator.error('Error processing CSV file', { error, filePath });
      throw new EducationalError(
        'Erreur lors du traitement du fichier CSV',
        500,
        'CSV_PROCESSING_ERROR'
      );
    }
  }

  /**
   * Traite une ligne du CSV
   */
  private async processRow(row: CsvRow, userId: number, result: CsvProcessingResult): Promise<void> {
    try {
      logDeduplicator.info('Processing CSV row', { 
        originalRow: row,
        userId 
      });

      // Valider les données
      this.validateRow(row);
      logDeduplicator.info('Row validation passed');

      // Normaliser les données
      const normalizedRow = this.normalizeRow(row);
      logDeduplicator.info('Row normalized', { normalizedRow });

      // Trouver ou créer la catégorie
      logDeduplicator.info('About to find/create category', { categoryName: normalizedRow.category, userId });
      
      let category = await this.findOrCreateCategory(normalizedRow.category, userId);
      logDeduplicator.info('Category found/created', { categoryId: category?.id, categoryName: normalizedRow.category });
      
      if (!category) {
        throw new Error(`Impossible de créer ou trouver la catégorie: ${normalizedRow.category}`);
      }

      // Vérifier si la ressource existe déjà
      const existingResource = await this.educationalResourceService.findByUrl(normalizedRow.link);
      logDeduplicator.info('Existing resource check', { 
        url: normalizedRow.link, 
        exists: !!existingResource 
      });

      if (existingResource) {
        // Si la ressource existe, on l'assigne à la catégorie si pas déjà fait
        await this.assignResourceToCategoryIfNeeded(existingResource.id, category.id, userId);
        logDeduplicator.info('Existing resource assigned to category');
        return;
      }

      // Créer la nouvelle ressource
      const resourceData = {
        url: normalizedRow.link,
        addedBy: userId
      };

      logDeduplicator.info('Creating new resource', { resourceData });
      const newResource = await this.educationalResourceService.create(resourceData);
      logDeduplicator.info('Resource created', { resourceId: newResource.id });

      // Assigner la ressource à la catégorie
      await this.educationalResourceService.assignToCategory({
        resourceId: newResource.id,
        categoryId: category.id,
        assignedBy: userId
      });

      logDeduplicator.info('Resource created and assigned to category', {
        resourceId: newResource.id,
        categoryId: category.id,
        url: normalizedRow.link
      });
    } catch (error) {
      logDeduplicator.error('Error in processRow', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        row 
      });
      throw error;
    }
  }

  /**
   * Valide une ligne du CSV
   */
  private validateRow(row: CsvRow): void {
    // Normaliser d'abord pour avoir les valeurs
    const normalized = this.normalizeRow(row);
    
    if (!normalized.link || normalized.link === '') {
      throw new Error('Le lien est requis et ne peut pas être vide');
    }

    if (!normalized.category || normalized.category === '') {
      throw new Error('La catégorie est requise et ne peut pas être vide');
    }

    // Valider l'URL
    try {
      new URL(normalized.link);
    } catch {
      throw new Error('Le lien doit être une URL valide');
    }

    // Limiter la longueur
    if (normalized.link.length > 500) {
      throw new Error('Le lien est trop long (maximum 500 caractères)');
    }

    if (normalized.category.length > 100) {
      throw new Error('La catégorie est trop longue (maximum 100 caractères)');
    }
  }

  /**
   * Normalise les données d'une ligne
   */
  private normalizeRow(row: CsvRow): { link: string; category: string } {
    // Gérer les deux cas : majuscules et minuscules
    const link = (row.Link || row.link || '').trim();
    const category = (row.Category || row.category || '').trim();
    
    return { link, category };
  }

  /**
   * Trouve ou crée une catégorie
   */
  private async findOrCreateCategory(categoryName: string, userId: number): Promise<any> {
    try {
      logDeduplicator.info('findOrCreateCategory called', { categoryName, userId });
      
      // Essayer de trouver la catégorie existante
      logDeduplicator.info('Looking for existing category', { categoryName });
      const existingCategory = await this.educationalCategoryService.findByName(categoryName);
      
      if (existingCategory) {
        logDeduplicator.info('Existing category found', { categoryId: existingCategory.id, categoryName });
        return existingCategory;
      }

      logDeduplicator.info('No existing category found, creating new one', { categoryName });
      
      // Créer une nouvelle catégorie
      const newCategory = await this.educationalCategoryService.create({
        name: categoryName,
        description: `Catégorie créée automatiquement lors de l'import CSV`,
        createdBy: userId
      });

      logDeduplicator.info('Category created during CSV import', {
        categoryId: newCategory.id,
        categoryName: categoryName,
        createdBy: userId
      });

      return newCategory;

    } catch (error) {
      logDeduplicator.error('Error finding or creating category', { 
        categoryName, 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new Error(`Erreur lors de la création de la catégorie: ${categoryName}`);
    }
  }

  /**
   * Assigne une ressource à une catégorie si pas déjà fait
   */
  private async assignResourceToCategoryIfNeeded(resourceId: number, categoryId: number, userId: number): Promise<void> {
    try {
      // Vérifier si l'association existe déjà
      const existingAssignment = await this.educationalResourceService.getResourceCategories(resourceId);
      const alreadyAssigned = existingAssignment.some(cat => cat.id === categoryId);

      if (!alreadyAssigned) {
        await this.educationalResourceService.assignToCategory({
          resourceId,
          categoryId,
          assignedBy: userId
        });

        logDeduplicator.info('Existing resource assigned to new category', {
          resourceId,
          categoryId,
          assignedBy: userId
        });
      }
    } catch (error) {
      logDeduplicator.error('Error assigning existing resource to category', { 
        resourceId, 
        categoryId, 
        error 
      });
      throw error;
    }
  }
} 