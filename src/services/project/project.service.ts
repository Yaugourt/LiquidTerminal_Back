import { ProjectResponse, ProjectCreateInput, ProjectUpdateInput } from '../../types/project.types';
import { projectRepository } from '../../repositories';
import { categoryRepository } from '../../repositories';
import { transactionService } from '../../core/transaction.service';
import { CACHE_PREFIX } from '../../constants/cache.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { BaseService } from '../../core/crudBase.service';
import { 
  ProjectNotFoundError, 
  ProjectAlreadyExistsError, 
  ProjectValidationError,
  CategoryNotFoundError 
} from '../../errors/project.errors';
import { 
  createProjectSchema, 
  updateProjectSchema, 
  projectQuerySchema,
  projectCategoriesUpdateSchema
} from '../../schemas/project.schema';

type ProjectQueryParams = {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  categoryIds?: number[];
};

export class ProjectService extends BaseService<ProjectResponse, ProjectCreateInput, ProjectUpdateInput, ProjectQueryParams> {
  protected repository = projectRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.PROJECT;
  protected validationSchemas = {
    create: createProjectSchema as any,
    update: updateProjectSchema as any,
    query: projectQuerySchema as any
  };
  protected errorClasses = {
    notFound: ProjectNotFoundError,
    alreadyExists: ProjectAlreadyExistsError,
    validation: ProjectValidationError
  };

  protected async checkExists(data: ProjectCreateInput): Promise<boolean> {
    return await this.repository.existsByTitle(data.title);
  }

  protected async checkExistsForUpdate(id: number, data: ProjectUpdateInput): Promise<boolean> {
    if (!data.title) return false;
    
    const existingProject = await this.repository.findById(id);
    if (!existingProject) return false;
    
    return existingProject.title !== data.title && await this.repository.existsByTitle(data.title);
  }

  protected async checkCanDelete(id: number): Promise<void> {
    // Vérifications spécifiques avant suppression si nécessaire
    const project = await this.repository.findById(id);
    if (!project) {
      throw new ProjectNotFoundError();
    }
  }

  /**
   * Assigne des catégories à un projet
   * @param projectId ID du projet
   * @param categoryIds IDs des catégories à assigner
   * @returns Projet mis à jour
   * @throws Erreur si le projet ou une catégorie n'existe pas
   */
  public async assignCategories(projectId: number, categoryIds: number[]) {
    try {
      // Validate input data
      const validationResult = projectCategoriesUpdateSchema.safeParse({ categoryIds });
      if (!validationResult.success) {
        throw new ProjectValidationError(validationResult.error.message);
      }

      // Utiliser le service de transaction pour l'assignation des catégories
      await transactionService.execute(async (tx) => {
        // Vérifier si le projet existe
        const project = await this.repository.findById(projectId);
        if (!project) {
          throw new ProjectNotFoundError();
        }

        // Vérifier si toutes les catégories existent
        for (const categoryId of categoryIds) {
          const category = await categoryRepository.findById(categoryId);
          if (!category) {
            throw new CategoryNotFoundError();
          }
        }

        // Assigner les catégories au projet
        await this.repository.assignCategories(projectId, categoryIds);
      });

      // Invalider le cache
      await this.invalidateEntityCache(projectId);
      await this.invalidateEntityListCache();

      logDeduplicator.info('Project categories assigned successfully', { 
        projectId, 
        categoryIds 
      });
      
      return await this.repository.findById(projectId);
    } catch (error) {
      if (error instanceof ProjectNotFoundError || 
          error instanceof CategoryNotFoundError || 
          error instanceof ProjectValidationError) {
        throw error;
      }
      logDeduplicator.error('Error assigning project categories:', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        categoryIds
      });
      throw error;
    }
  }

  /**
   * Retire des catégories d'un projet
   * @param projectId ID du projet
   * @param categoryIds IDs des catégories à retirer
   * @returns Projet mis à jour
   * @throws Erreur si le projet n'existe pas
   */
  public async removeCategories(projectId: number, categoryIds: number[]) {
    try {
      // Validate input data
      const validationResult = projectCategoriesUpdateSchema.safeParse({ categoryIds });
      if (!validationResult.success) {
        throw new ProjectValidationError(validationResult.error.message);
      }

      // Utiliser le service de transaction pour le retrait des catégories
      await transactionService.execute(async (tx) => {
        // Vérifier si le projet existe
        const project = await this.repository.findById(projectId);
        if (!project) {
          throw new ProjectNotFoundError();
        }

        // Retirer les catégories du projet
        await this.repository.removeCategories(projectId, categoryIds);
      });

      // Invalider le cache
      await this.invalidateEntityCache(projectId);
      await this.invalidateEntityListCache();

      logDeduplicator.info('Project categories removed successfully', { 
        projectId, 
        categoryIds 
      });
      
      return await this.repository.findById(projectId);
    } catch (error) {
      if (error instanceof ProjectNotFoundError || 
          error instanceof ProjectValidationError) {
        throw error;
      }
      logDeduplicator.error('Error removing project categories:', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        categoryIds
      });
      throw error;
    }
  }

  /**
   * Récupère toutes les catégories d'un projet
   * @param projectId ID du projet
   * @returns Liste des catégories du projet
   * @throws Erreur si le projet n'existe pas
   */
  public async getProjectCategories(projectId: number) {
    try {
      // Vérifier si le projet existe
      const project = await this.repository.findById(projectId);
      if (!project) {
        throw new ProjectNotFoundError();
      }

      const categories = await this.repository.getProjectCategories(projectId);

      logDeduplicator.info('Project categories retrieved successfully', { 
        projectId,
        count: categories.length
      });
      
      return categories;
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        throw error;
      }
      logDeduplicator.error('Error fetching project categories:', { error: error instanceof Error ? error.message : String(error), projectId });
      throw error;
    }
  }

  /**
   * Crée un projet avec gestion d'upload de fichier
   * @param data Données du projet avec logo optionnel
   * @returns Projet créé
   */
  public async createWithUpload(data: ProjectCreateInput) {
    try {
      // Nettoyer les données
      const cleanData = { ...data };
      
      // Si logo est un objet vide ou undefined, le supprimer
      if (!cleanData.logo || (typeof cleanData.logo === 'object' && Object.keys(cleanData.logo).length === 0)) {
        delete cleanData.logo;
      }
      
      // Convertir les strings en numbers dans categoryIds (au cas où)
      if (cleanData.categoryIds && Array.isArray(cleanData.categoryIds)) {
        cleanData.categoryIds = cleanData.categoryIds.map(id => 
          typeof id === 'string' ? parseInt(id, 10) : id
        );
      }
      
      // Si pas de logo, utiliser une image par défaut
      const projectData: ProjectCreateInput = {
        ...cleanData,
        logo: cleanData.logo || 'https://via.placeholder.com/150x150.png?text=No+Logo'
      };

      // Vérifier si un projet avec le même titre existe déjà
      const exists = await this.checkExists(projectData);
      if (exists) {
        throw new ProjectAlreadyExistsError();
      }

      // Créer le projet directement avec le repository (sans validation du service de base)
      const project = await this.repository.create(projectData);
      
      // Invalider le cache
      await this.invalidateEntityListCache();

      logDeduplicator.info('Project created with upload successfully', { 
        id: project.id, 
        title: project.title 
      });

      return project;
    } catch (error) {
      logDeduplicator.error('Error creating project with upload:', { error: error instanceof Error ? error.message : String(error), data });
      throw error;
    }
  }

  /**
   * Récupère tous les projets d'une catégorie
   * @param categoryId ID de la catégorie
   * @returns Liste des projets de la catégorie
   * @throws Erreur si la catégorie n'existe pas
   */
  public async getProjectsByCategory(categoryId: number) {
    try {
      // Vérifier si la catégorie existe
      const category = await categoryRepository.findById(categoryId);
      if (!category) {
        throw new CategoryNotFoundError();
      }

      const projects = await this.repository.findAll({ categoryIds: [categoryId] });

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

  async delete(id: number) {
    try {
      await this.checkCanDelete(id);
      await this.repository.delete(id);
      await this.invalidateEntityCache(id);
      await this.invalidateEntityListCache();
      
      logDeduplicator.info('Project deleted successfully', { id });
    } catch (error) {
      logDeduplicator.error('Error deleting project:', { error: error instanceof Error ? error.message : String(error), id });
      throw error;
    }
  }
} 