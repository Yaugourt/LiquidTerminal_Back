import { parse } from 'csv-parse/sync';
import fs from 'fs';
import { ProjectService } from './project.service';
import { CategoryService } from './category.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ProjectError } from '../../errors/project.errors';
import { ProjectCsvRow, CsvProjectProcessingResult } from '../../types/csv-project.types';

export class CsvProjectService {
  private projectService: ProjectService;
  private categoryService: CategoryService;

  constructor() {
    this.projectService = new ProjectService();
    this.categoryService = new CategoryService();
  }

  /**
   * Traite un fichier CSV et importe les projets
   */
  async processCsvFile(filePath: string): Promise<CsvProjectProcessingResult> {
    const result: CsvProjectProcessingResult = {
      totalRows: 0,
      successfulImports: 0,
      failedImports: 0,
      errors: [],
      createdCategories: []
    };

    try {
      // Lire le fichier CSV
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      
      logDeduplicator.info('Starting CSV project import', {
        filePath,
        fileSize: fileContent.length
      });

      // Parser le CSV
      const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: ','
      }) as ProjectCsvRow[];

      result.totalRows = records.length;
      
      logDeduplicator.info('CSV parsed successfully', { 
        totalRows: result.totalRows,
        firstRow: records[0]
      });

      // Traiter chaque ligne
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNumber = i + 2; // +2 car on compte à partir de 1 et on a sauté l'en-tête

        // Ignorer les lignes vides
        if (!row.title || row.title.trim() === '') {
          logDeduplicator.info('Skipping empty row', { rowNumber });
          continue;
        }

        try {
          await this.processRow(row, result);
          result.successfulImports++;
          logDeduplicator.info('Project row processed successfully', { rowNumber });
        } catch (error) {
          result.failedImports++;
          
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          result.errors.push({
            row: rowNumber,
            error: errorMessage,
            data: row
          });
          
          logDeduplicator.error('Error processing project CSV row', { 
            row: rowNumber, 
            error: errorMessage,
            data: row
          });
        }
      }

      logDeduplicator.info('CSV project processing completed', {
        totalRows: result.totalRows,
        successfulImports: result.successfulImports,
        failedImports: result.failedImports,
        createdCategories: result.createdCategories
      });

      return result;

    } catch (error) {
      logDeduplicator.error('Error processing CSV project file', { error: error instanceof Error ? error.message : String(error), filePath });
      throw new ProjectError(
        'Erreur lors du traitement du fichier CSV',
        500,
        'CSV_PROCESSING_ERROR'
      );
    }
  }

  /**
   * Traite une ligne du CSV
   */
  private async processRow(row: ProjectCsvRow, result: CsvProjectProcessingResult): Promise<void> {
    try {
      // Normaliser les données
      const normalizedRow = this.normalizeRow(row);
      
      // Valider et corriger les données (modifie normalizedRow en place)
      this.validateRow(normalizedRow);

      // Gérer la catégorie si spécifiée
      let categoryIds: number[] | undefined = undefined;
      if (normalizedRow.category) {
        const category = await this.findOrCreateCategory(normalizedRow.category, result);
        if (category) {
          categoryIds = [category.id];
        }
      }

      // Vérifier si le projet existe déjà (par titre)
      const existingProjects = await this.projectService.getAll({ search: normalizedRow.title });
      const exactMatch = existingProjects.data.find(
        (project: any) => project.title.toLowerCase() === normalizedRow.title.toLowerCase()
      );

      if (exactMatch) {
        logDeduplicator.warn('Project already exists, skipping', { 
          title: normalizedRow.title,
          existingId: (exactMatch as unknown as { id: number }).id 
        });
        return;
      }

      // Créer le nouveau projet (utiliser les valeurs corrigées de validateRow)
      const projectData = {
        title: normalizedRow.title,
        desc: normalizedRow.desc,
        logo: this.buildLogoUrl(normalizedRow.logo),
        banner: normalizedRow.banner ? this.buildLogoUrl(normalizedRow.banner) : undefined,
        token: normalizedRow.token || undefined,
        twitter: normalizedRow.twitter || undefined,
        discord: normalizedRow.discord || undefined,
        telegram: normalizedRow.telegram || undefined,
        website: normalizedRow.website || undefined,
        categoryIds
      };

      // Utiliser createWithUpload qui ne nécessite pas de validation middleware
      const newProject = await this.projectService.createWithUpload(projectData);

      logDeduplicator.info('Project created from CSV', {
        projectId: newProject.id,
        title: normalizedRow.title,
        categoryIds
      });

    } catch (error) {
      logDeduplicator.error('Error in processRow', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        row 
      });
      throw error;
    }
  }

  /**
   * Valide une ligne du CSV (modifie les données en place)
   */
  private validateRow(normalized: any): void {
    
    if (!normalized.title || normalized.title === '') {
      throw new Error('Le titre est requis et ne peut pas être vide');
    }

    if (!normalized.desc || normalized.desc === '') {
      throw new Error('La description est requise et ne peut pas être vide');
    }

    if (!normalized.logo || normalized.logo === '') {
      throw new Error('Le logo est requis et ne peut pas être vide');
    }

    // Valider le logo (URL complète ou nom de fichier)
    if (!this.isValidLogoPath(normalized.logo)) {
      throw new Error('Le logo doit être une URL valide ou un nom de fichier (ex: logo.jpg)');
    }

    // Valider le banner s'il est présent (optionnel)
    if (normalized.banner && normalized.banner !== '' && !this.isValidLogoPath(normalized.banner)) {
      throw new Error('Le banner doit être une URL valide ou un nom de fichier (ex: banner.jpg)');
    }

    // Valider les URLs optionnelles
    const urlFields = ['twitter', 'discord', 'telegram', 'website'];
    for (const field of urlFields) {
      let url = normalized[field as keyof typeof normalized];
      if (url && url !== '') {
        // Correction automatique pour les URLs Telegram malformées
        if (field === 'telegram' && url.startsWith('t.me/')) {
          url = 'https://' + url;
          // Mettre à jour la valeur normalisée
          (normalized as any)[field] = url;
        }
        
        try {
          new URL(url);
        } catch {
          throw new Error(`${field} doit être une URL valide`);
        }
      }
    }

    // Limiter les longueurs
    if (normalized.title.length > 255) {
      throw new Error('Le titre est trop long (maximum 255 caractères)');
    }

    if (normalized.desc.length > 255) {
      // Tronquer la description au lieu de la rejeter
      normalized.desc = normalized.desc.substring(0, 252) + '...';
      logDeduplicator.warn('Description truncated', { 
        originalLength: normalized.desc.length,
        title: normalized.title 
      });
    }

    if (normalized.category && normalized.category.length > 100) {
      throw new Error('La catégorie est trop longue (maximum 100 caractères)');
    }
  }

  /**
   * Valide si le logo est une URL valide ou un nom de fichier valide
   */
  private isValidLogoPath(logo: string): boolean {
    // Essayer d'abord comme URL complète
    try {
      new URL(logo);
      return true;
    } catch {
      // Si ce n'est pas une URL, vérifier si c'est un nom de fichier valide
      return this.isValidFileName(logo);
    }
  }

  /**
   * Valide si c'est un nom de fichier d'image valide
   */
  private isValidFileName(filename: string): boolean {
    // Extensions autorisées
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    
    // Vérifier l'extension
    if (!allowedExtensions.includes(ext)) {
      return false;
    }

    // Vérifier que le nom ne contient pas de caractères dangereux
    // Autorise lettres, chiffres, points, tirets, underscores, et quelques symboles courants
    const safePattern = /^[a-zA-Z0-9._\-$@#%&()\[\]{}!+=~]+$/;
    return safePattern.test(filename) && filename.length <= 100;
  }

  /**
   * Construit l'URL complète du logo
   */
  private buildLogoUrl(logo: string): string {
    // Si c'est déjà une URL complète, la retourner telle quelle
    try {
      new URL(logo);
      return logo;
    } catch {
      // Si c'est un nom de fichier, construire l'URL complète
      const baseUrl = process.env.BASE_URL || 'http://localhost:3002';
      return `${baseUrl}/uploads/logos/${logo}`;
    }
  }

  /**
   * Normalise les données d'une ligne
   */
  private normalizeRow(row: ProjectCsvRow): {
    title: string;
    desc: string;
    logo: string;
    banner?: string;
    twitter?: string;
    discord?: string;
    telegram?: string;
    website?: string;
    token?: string;
    category?: string;
  } {
    return {
      title: (row.title || '').trim(),
      desc: (row.desc || '').trim(),
      logo: (row.logo || '').trim(),
      banner: (row.Banner || row.banner || '').trim() || undefined,
      twitter: (row.twitter || '').trim() || undefined,
      discord: (row.discord || '').trim() || undefined,
      telegram: (row.telegram || '').trim() || undefined,
      website: (row.website || '').trim() || undefined,
      token: (row.Token || row.token || '').trim() || undefined,
      category: (row.Category || row.category || '').trim() || undefined,
    };
  }

  /**
   * Trouve ou crée une catégorie
   */
  private async findOrCreateCategory(categoryName: string, result: CsvProjectProcessingResult): Promise<any> {
    try {
      logDeduplicator.info('findOrCreateCategory called', { categoryName });
      
      // Utiliser la nouvelle méthode findByName qui est case-insensitive
      const existingCategory = await this.categoryService.findByName(categoryName);
      
      if (existingCategory) {
        logDeduplicator.info('Existing category found', { 
          categoryId: existingCategory.id, 
          categoryName: existingCategory.name 
        });
        return existingCategory;
      }

      logDeduplicator.info('No existing category found, creating new one', { categoryName });
      
      try {
        // Créer une nouvelle catégorie
        const newCategory = await this.categoryService.create({
          name: categoryName,
          description: `Catégorie créée automatiquement lors de l'import CSV de projets`
        });

        // Ajouter à la liste des catégories créées
        if (!result.createdCategories.includes(categoryName)) {
          result.createdCategories.push(categoryName);
        }

        logDeduplicator.info('Category created during CSV import', {
          categoryId: newCategory.id,
          categoryName: categoryName
        });

        return newCategory;
      } catch (createError: any) {
        // Si la catégorie existe déjà (race condition), essayer de la récupérer à nouveau
        if (createError.message?.includes('already exists')) {
          logDeduplicator.warn('Category was created by another process, fetching again', { categoryName });
          const retryExisting = await this.categoryService.findByName(categoryName);
          if (retryExisting) {
            return retryExisting;
          }
        }
        throw createError;
      }

    } catch (error) {
      logDeduplicator.error('Error finding or creating category', { 
        categoryName, 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new Error(`Erreur lors de la création de la catégorie: ${categoryName}`);
    }
  }
}
