import {
  EducationalCategoryCreateInput,
  EducationalCategoryUpdateInput,
  EducationalCategoryResponse
} from '../../types/educational.types';
import { BasePagination } from '../../types/common.types';
import { 
  EducationalCategoryNotFoundError, 
  EducationalCategoryAlreadyExistsError,
  EducationalCategoryValidationError 
} from '../../errors/educational.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { CACHE_PREFIX, CACHE_KEYS } from '../../constants/cache.constants';
import { 
  educationalCategoryCreateSchema, 
  educationalCategoryUpdateSchema, 
  educationalCategoryQuerySchema 
} from '../../schemas/educational.schema';
import { educationalCategoryRepository } from '../../repositories';
import { BaseService, AnyPrismaClient } from '../../core/crudBase.service';
import { prismaContent } from '../../core/prisma.content.service';
import { cacheService } from '../../core/cache.service';
import { CACHE_TTL } from '../../constants/cache.constants';

// Type pour les paramètres de requête
type EducationalCategoryQueryParams = {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
};

export class EducationalCategoryService extends BaseService<
  EducationalCategoryResponse, 
  EducationalCategoryCreateInput, 
  EducationalCategoryUpdateInput, 
  EducationalCategoryQueryParams
> {
  protected repository = educationalCategoryRepository;
  protected transactionClient = prismaContent as unknown as AnyPrismaClient;
  protected cacheKeyPrefix = CACHE_PREFIX.EDUCATIONAL_CATEGORY;
  protected validationSchemas = {
    create: educationalCategoryCreateSchema,
    update: educationalCategoryUpdateSchema,
    query: educationalCategoryQuerySchema
  };
  protected errorClasses = {
    notFound: EducationalCategoryNotFoundError,
    alreadyExists: EducationalCategoryAlreadyExistsError,
    validation: EducationalCategoryValidationError
  };

  /**
   * Vérifie si une catégorie éducative avec le nom donné existe déjà
   * @param data Données de la catégorie éducative
   * @returns true si la catégorie existe déjà, false sinon
   */
  protected async checkExists(data: EducationalCategoryCreateInput): Promise<boolean> {
    return await this.repository.existsByName(data.name);
  }

  /**
   * Vérifie si une catégorie éducative avec le nom donné existe déjà (pour la mise à jour)
   * @param id ID de la catégorie à mettre à jour
   * @param data Données de mise à jour
   * @returns true si une autre catégorie avec le même nom existe déjà, false sinon
   */
  protected async checkExistsForUpdate(id: number, data: EducationalCategoryUpdateInput): Promise<boolean> {
    if (data.name) {
      const category = await this.repository.findById(id);
      if (category && data.name !== category.name) {
        return await this.repository.existsByName(data.name);
      }
    }
    return false;
  }

  /**
   * Vérifie si une catégorie éducative peut être supprimée.
   * Intentionally unfiltered: a category holding only PENDING/REJECTED
   * resources must still be undeletable, otherwise the cascade would
   * silently drop their assignments.
   */
  protected async checkCanDelete(id: number): Promise<void> {
    const resources = await this.repository.getResourcesByCategory(id);
    if (resources.length > 0) {
      throw new EducationalCategoryValidationError('Cannot delete category with associated resources');
    }
  }



  /**
   * Récupère toutes les ressources d'une catégorie éducative
   * @param categoryId ID de la catégorie
   * @returns Liste des ressources de la catégorie
   * @throws Erreur si la catégorie n'est pas trouvée
   */
  async getResourcesByCategory(categoryId: number) {
    try {
      return await cacheService.getOrSet(
        CACHE_KEYS.EDUCATIONAL_RESOURCE_BY_CATEGORY(categoryId),
        async () => {
          const category = await this.repository.findById(categoryId);
          if (!category) {
            throw new EducationalCategoryNotFoundError();
          }

          // Public endpoint: only approved resources are visible.
          const resources = await this.repository.getResourcesByCategory(categoryId, 'APPROVED');

          logDeduplicator.info('Resources by educational category retrieved successfully', { 
            categoryId,
            count: resources.length
          });
          
          return resources;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      if (error instanceof EducationalCategoryNotFoundError) {
        throw error;
      }
      logDeduplicator.error('Error fetching resources by educational category:', { error: error instanceof Error ? error.message : String(error), categoryId });
      throw error;
    }
  }



  /**
   * Liste les catégories avec le nombre de ressources APPROVED de chacune.
   * Un seul groupBy pour tous les counts, mis en cache sous sa propre clé
   * (invalidée par le service ressource à chaque approve/reject/assign).
   */
  async getAllWithCounts(query: EducationalCategoryQueryParams): Promise<{
    data: Array<EducationalCategoryResponse & { resourcesCount: number }>;
    pagination: BasePagination;
  }> {
    const [result, counts] = await Promise.all([
      this.getAll(query),
      cacheService.getOrSet(
        CACHE_KEYS.EDUCATIONAL_CATEGORY_COUNTS,
        async () => {
          const map = await this.repository.countResourcesByCategory('APPROVED');
          // Redis serializes to JSON: store as a plain object, rebuild below.
          return Object.fromEntries(map);
        },
        CACHE_TTL.MEDIUM
      )
    ]);

    const countsByCategory: Record<string, number> = counts ?? {};
    return {
      data: result.data.map((category: EducationalCategoryResponse) => ({
        ...category,
        resourcesCount: countsByCategory[String(category.id)] ?? 0
      })),
      // CrudRepository types pagination minimally; the repo builds the full shape.
      pagination: result.pagination as BasePagination
    };
  }

  /**
   * Invalide le cache spécifique aux catégories éducatives
   * @param id ID de la catégorie
   */
  protected async invalidateEducationalCategoryCache(id: number): Promise<void> {
    await Promise.all([
      this.invalidateEntityCache(id),
      cacheService.invalidateByPattern(`${CACHE_PREFIX.EDUCATIONAL_RESOURCE}:category:*`)
    ]);
  }

  /**
   * Override de la méthode create pour invalider les caches spécifiques
   */
  async create(data: EducationalCategoryCreateInput): Promise<EducationalCategoryResponse> {
    const result = await super.create(data);
    await this.invalidateEducationalCategoryCache(result.id);
    return result;
  }

  /**
   * Override de la méthode update pour invalider les caches spécifiques
   */
  async update(id: number, data: EducationalCategoryUpdateInput): Promise<EducationalCategoryResponse> {
    const result = await super.update(id, data);
    await this.invalidateEducationalCategoryCache(id);
    return result;
  }

  /**
   * Override de la méthode delete pour invalider les caches spécifiques
   */
  async delete(id: number): Promise<void> {
    await super.delete(id);
    await this.invalidateEducationalCategoryCache(id);
  }

  /**
   * Trouve une catégorie par son nom
   */
  async findByName(name: string): Promise<EducationalCategoryResponse | null> {
    try {
      return await this.repository.findByName(name);
    } catch (error) {
      logDeduplicator.error('Error finding category by name:', { error: error instanceof Error ? error.message : String(error), name });
      throw error;
    }
  }
} 