import { CategoryCreateInput, CategoryUpdateInput, CategoryResponse } from '../../types/project.types';
import { 
  CategoryNotFoundError, 
  CategoryAlreadyExistsError,
  CategoryValidationError 
} from '../../errors/project.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import {CACHE_PREFIX} from '../../constants/cache.constants';
import { 
  categoryCreateSchema, 
  categoryUpdateSchema, 
  categoryQuerySchema 
} from '../../schemas/category.schema';
import { categoryRepository, projectRepository } from '../../repositories';
import { BaseService, AnyPrismaClient } from '../../core/crudBase.service';
import { prismaContent } from '../../core/prisma.content.service';

// Type pour les paramètres de requête
type CategoryQueryParams = {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
};

export class CategoryService extends BaseService<CategoryResponse, CategoryCreateInput, CategoryUpdateInput, CategoryQueryParams> {
  protected repository = categoryRepository;
  protected transactionClient = prismaContent as unknown as AnyPrismaClient;
  protected cacheKeyPrefix = CACHE_PREFIX.CATEGORY;
  protected validationSchemas = {
    create: categoryCreateSchema,
    update: categoryUpdateSchema,
    query: categoryQuerySchema
  };
  protected errorClasses = {
    notFound: CategoryNotFoundError,
    alreadyExists: CategoryAlreadyExistsError,
    validation: CategoryValidationError
  };

  /**
   * Vérifie si une catégorie avec le nom donné existe déjà
   * @param data Données de la catégorie
   * @returns true si la catégorie existe déjà, false sinon
   */
  protected async checkExists(data: CategoryCreateInput): Promise<boolean> {
    return await this.repository.existsByName(data.name);
  }

  /**
   * Vérifie si une catégorie avec le nom donné existe déjà (pour la mise à jour)
   * @param id ID de la catégorie à mettre à jour
   * @param data Données de mise à jour
   * @returns true si une autre catégorie avec le même nom existe déjà, false sinon
   */
  protected async checkExistsForUpdate(id: number, data: CategoryUpdateInput): Promise<boolean> {
    if (data.name) {
      const category = await this.repository.findById(id);
      if (category && data.name !== category.name) {
        return await this.repository.existsByName(data.name);
      }
    }
    return false;
  }

  /**
   * Vérifie si une catégorie peut être supprimée
   * @param id ID de la catégorie à supprimer
   * @throws Erreur si la catégorie ne peut pas être supprimée
   */
  protected async checkCanDelete(id: number): Promise<void> {
    const projects = await projectRepository.findAll({ categoryIds: [id] });
    if (projects.data.length > 0) {
      throw new CategoryValidationError('Cannot delete category with associated projects');
    }
  }

  /**
   * Récupère une catégorie avec ses projets
   * @param id ID de la catégorie
   * @returns Catégorie avec ses projets
   * @throws Erreur si la catégorie n'est pas trouvée
   */
  async getCategoryWithProjects(id: number) {
    try {
      const category = await this.repository.findByIdWithProjects(id);
      if (!category) {
        throw new CategoryNotFoundError();
      }

      logDeduplicator.info('Category with projects retrieved successfully', { 
        categoryId: id,
        projectsCount: category.projects.length
      });

      return category;
    } catch (error) {
      if (error instanceof CategoryNotFoundError) {
        throw error;
      }
      logDeduplicator.error('Error fetching category with projects:', { error: error instanceof Error ? error.message : String(error), categoryId: id });
      throw error;
    }
  }

  /**
   * Récupère tous les projets d'une catégorie
   * @param categoryId ID de la catégorie
   * @returns Liste des projets de la catégorie
   * @throws Erreur si la catégorie n'est pas trouvée
   */
  async getProjectsByCategory(categoryId: number) {
    try {
      const category = await this.repository.findById(categoryId);
      if (!category) {
        throw new CategoryNotFoundError();
      }

      const projects = await projectRepository.findAll({ categoryIds: [categoryId] });

      logDeduplicator.info('Projects by category retrieved successfully', { 
        categoryId,
        count: projects.data.length
      });
      
      return projects.data;
    } catch (error) {
      if (error instanceof CategoryNotFoundError) {
        throw error;
      }
      logDeduplicator.error('Error fetching projects by category:', { error: error instanceof Error ? error.message : String(error), categoryId });
      throw error;
    }
  }

  /**
   * Trouve une catégorie par son nom (case-insensitive)
   * @param name Nom de la catégorie
   * @returns Catégorie trouvée ou null
   */
  async findByName(name: string): Promise<CategoryResponse | null> {
    try {
      return await this.repository.findByName(name);
    } catch (error) {
      logDeduplicator.error('Error finding category by name:', { error: error instanceof Error ? error.message : String(error), name });
      throw error;
    }
  }
} 