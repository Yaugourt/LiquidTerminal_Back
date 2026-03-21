import { parse } from 'csv-parse';
import { Readable } from 'stream';
import { ProjectCreateInput } from '../../types/project.types';
import { ProjectService } from './project.service';
import { CategoryService } from './category.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { transactionService } from '../../core/transaction.service';

type ProjectCSVRow = {
  title: string;
  desc: string;
  logo: string;
  banner?: string;
  token?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  website?: string;
  category?: string;
};

export class ProjectImportService {
  constructor(
    private projectService: ProjectService,
    private categoryService: CategoryService
  ) {}

  /**
   * Importe des projets depuis un contenu CSV
   * @param csvContent Contenu du fichier CSV
   * @returns Résultat de l'import avec le nombre de projets importés et les erreurs éventuelles
   */
  async importProjectsFromCSV(csvContent: string) {
    const results = {
      imported: 0,
      errors: [] as { row: number; error: string }[],
    };

    try {
      // Créer un stream à partir du contenu CSV
      const stream = Readable.from([csvContent]);

      // Parser le CSV
      const parser = stream.pipe(
        parse({
          columns: true,
          skip_empty_lines: true,
          trim: true,
        })
      );

      let rowNumber = 1;
      for await (const row of parser) {
        try {
          await this.importSingleProject(row as ProjectCSVRow);
          results.imported++;
        } catch (error) {
          results.errors.push({
            row: rowNumber,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        rowNumber++;
      }

      logDeduplicator.info('CSV import completed', {
        imported: results.imported,
        errors: results.errors.length,
      });

      return results;
    } catch (error) {
      logDeduplicator.error('Error during CSV import:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Importe un seul projet depuis une ligne CSV
   * @param row Données du projet depuis le CSV
   */
  private async importSingleProject(row: ProjectCSVRow) {
    return await transactionService.execute(async () => {
      // Si une catégorie est spécifiée, la créer ou la récupérer
      let categoryIds: number[] | undefined = undefined;
      if (row.category) {
        const category = await this.ensureCategory(row.category);
        categoryIds = [category.id];
      }

      // Créer le projet
      const projectData: ProjectCreateInput = {
        title: row.title,
        desc: row.desc,
        logo: row.logo,
        banner: row.banner,
        token: row.token,
        twitter: row.twitter,
        discord: row.discord,
        telegram: row.telegram,
        website: row.website,
        categoryIds,
      };

      return await this.projectService.create(projectData);
    });
  }

  /**
   * S'assure qu'une catégorie existe, la crée si nécessaire
   * @param categoryName Nom de la catégorie
   * @returns Catégorie créée ou existante
   */
  private async ensureCategory(categoryName: string) {
    try {
      // Rechercher la catégorie existante
      const existingCategories = await this.categoryService.getAll({});
      
      const exactMatch = existingCategories.data.find(
        (cat: { name: string }) => cat.name.toLowerCase() === categoryName.toLowerCase()
      );

      if (exactMatch) {
        return exactMatch;
      }

      // Créer la catégorie si elle n'existe pas
      return await this.categoryService.create({
        name: categoryName,
        description: `Category for ${categoryName} projects`,
      });
    } catch (error) {
      logDeduplicator.error('Error ensuring category exists:', {
        error: error instanceof Error ? error.message : String(error),
        categoryName,
      });
      throw error;
    }
  }
} 