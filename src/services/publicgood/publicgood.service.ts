import { PublicGoodResponse, PublicGoodCreateInput, PublicGoodUpdateInput, PublicGoodQueryParams } from '../../types/publicgood.types';
import { publicGoodRepository } from '../../repositories';
import { CACHE_PREFIX } from '../../constants/cache.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { BaseService } from '../../core/crudBase.service';
import { 
  PublicGoodNotFoundError, 
  PublicGoodAlreadyExistsError, 
  PublicGoodValidationError,
  PublicGoodPermissionError
} from '../../errors/publicgood.errors';
import { 
  publicGoodCreateSchema, 
  publicGoodUpdateSchema, 
  publicGoodQuerySchema 
} from '../../schemas/publicgood.schema';
import { ProjectStatus } from '@prisma/client';

export class PublicGoodService extends BaseService<
  PublicGoodResponse, 
  PublicGoodCreateInput, 
  PublicGoodUpdateInput, 
  PublicGoodQueryParams
> {
  protected repository = publicGoodRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.PUBLIC_GOOD || 'publicgood';
  protected validationSchemas = {
    create: publicGoodCreateSchema.shape.body as any,
    update: publicGoodUpdateSchema.shape.body as any,
    query: publicGoodQuerySchema.shape.query as any
  };
  protected errorClasses = {
    notFound: PublicGoodNotFoundError,
    alreadyExists: PublicGoodAlreadyExistsError,
    validation: PublicGoodValidationError
  };

  /**
   * Vérifie si un public good avec le nom donné existe déjà
   */
  protected async checkExists(data: PublicGoodCreateInput): Promise<boolean> {
    return await this.repository.existsByName(data.name);
  }

  /**
   * Vérifie si un public good avec le nom donné existe déjà (pour la mise à jour)
   */
  protected async checkExistsForUpdate(id: number, data: PublicGoodUpdateInput): Promise<boolean> {
    if (!data.name) return false;
    
    const existingPublicGood = await this.repository.findById(id);
    if (!existingPublicGood) return false;
    
    return existingPublicGood.name !== data.name && await this.repository.existsByName(data.name);
  }

  /**
   * Vérifie si un public good peut être supprimé
   */
  protected async checkCanDelete(id: number): Promise<void> {
    const publicGood = await this.repository.findById(id);
    if (!publicGood) {
      throw new PublicGoodNotFoundError();
    }
  }

  /**
   * Crée un nouveau public good
   */
  async create(data: PublicGoodCreateInput): Promise<PublicGoodResponse> {
    try {
      // Vérifier si existe déjà
      const exists = await this.checkExists(data);
      if (exists) {
        throw new PublicGoodAlreadyExistsError();
      }

      // Créer le public good avec status PENDING par défaut (géré par le repository/prisma)
      const publicGood = await this.repository.create(data);
      
      // Invalider le cache
      await this.invalidateEntityListCache();

      logDeduplicator.info('Public good created successfully', { 
        id: publicGood.id, 
        name: publicGood.name 
      });

      return publicGood;
    } catch (error) {
      logDeduplicator.error('Error creating public good:', { error: error instanceof Error ? error.message : String(error), data });
      throw error;
    }
  }

  /**
   * Met à jour un public good existant
   * Si le projet était APPROVED et qu'on le modifie, on reset à PENDING
   */
  async update(id: number, data: PublicGoodUpdateInput): Promise<PublicGoodResponse> {
    try {
      // Vérifier que le public good existe
      const existingPublicGood = await this.repository.findById(id);
      if (!existingPublicGood) {
        throw new PublicGoodNotFoundError();
      }

      // Vérifier si un autre public good avec le même nom existe
      const existsForUpdate = await this.checkExistsForUpdate(id, data);
      if (existsForUpdate) {
        throw new PublicGoodAlreadyExistsError();
      }

      // Si le projet était APPROVED, on reset à PENDING après modification
      let publicGood;
      if (existingPublicGood.status === 'APPROVED') {
        logDeduplicator.info('Public good was APPROVED, resetting to PENDING after update', { id });
        // Update les données ET reset le status à PENDING
        publicGood = await this.repository.update(id, data);
        // Puis update le status séparément via review
        publicGood = await this.repository.review(id, {
          status: 'PENDING' as ProjectStatus,
          reviewerId: existingPublicGood.reviewerId || 0,
          reviewNotes: 'Reset to PENDING after modification'
        });
      } else {
        publicGood = await this.repository.update(id, data);
      }
      
      // Invalider le cache
      await this.invalidateEntityCache(id);
      await this.invalidateEntityListCache();

      logDeduplicator.info('Public good updated successfully', { 
        id: publicGood.id, 
        name: publicGood.name 
      });

      return publicGood;
    } catch (error) {
      logDeduplicator.error('Error updating public good:', { error: error instanceof Error ? error.message : String(error), id, data });
      throw error;
    }
  }

  /**
   * Supprime un public good
   */
  async delete(id: number): Promise<void> {
    try {
      await this.checkCanDelete(id);
      await this.repository.delete(id);
      
      // Invalider le cache
      await this.invalidateEntityCache(id);
      await this.invalidateEntityListCache();
      
      logDeduplicator.info('Public good deleted successfully', { id });
    } catch (error) {
      logDeduplicator.error('Error deleting public good:', { error: error instanceof Error ? error.message : String(error), id });
      throw error;
    }
  }

  /**
   * Récupère tous les public goods soumis par un utilisateur
   */
  async getBySubmitter(submitterId: number, params: PublicGoodQueryParams): Promise<{
    data: PublicGoodResponse[];
    pagination: any;
  }> {
    try {
      const result = await this.repository.findBySubmitter(submitterId, params);
      
      logDeduplicator.info('Public goods by submitter retrieved successfully', { 
        submitterId,
        count: result.data.length
      });
      
      return result;
    } catch (error) {
      logDeduplicator.error('Error fetching public goods by submitter:', { error: error instanceof Error ? error.message : String(error), submitterId });
      throw error;
    }
  }

  /**
   * Récupère tous les public goods en attente de review
   */
  async getPending(params: PublicGoodQueryParams): Promise<{
    data: PublicGoodResponse[];
    pagination: any;
  }> {
    try {
      const result = await this.repository.findPending(params);
      
      logDeduplicator.info('Pending public goods retrieved successfully', { 
        count: result.data.length
      });
      
      return result;
    } catch (error) {
      logDeduplicator.error('Error fetching pending public goods:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Review un public good (MODERATOR/ADMIN)
   */
  async review(id: number, reviewData: {
    status: 'APPROVED' | 'REJECTED';
    reviewerId: number;
    reviewNotes?: string;
  }): Promise<PublicGoodResponse> {
    try {
      // Vérifier que le public good existe
      const existingPublicGood = await this.repository.findById(id);
      if (!existingPublicGood) {
        throw new PublicGoodNotFoundError();
      }

      const publicGood = await this.repository.review(id, {
        status: reviewData.status as ProjectStatus,
        reviewerId: reviewData.reviewerId,
        reviewNotes: reviewData.reviewNotes
      });
      
      // Invalider le cache
      await this.invalidateEntityCache(id);
      await this.invalidateEntityListCache();

      logDeduplicator.info('Public good reviewed successfully', { 
        id: publicGood.id, 
        status: reviewData.status,
        reviewerId: reviewData.reviewerId
      });

      return publicGood;
    } catch (error) {
      logDeduplicator.error('Error reviewing public good:', { error: error instanceof Error ? error.message : String(error), id, reviewData });
      throw error;
    }
  }

  /**
   * Vérifie si un utilisateur est propriétaire d'un public good
   */
  async isOwner(id: number, userId: number): Promise<boolean> {
    try {
      return await this.repository.isOwner(id, userId);
    } catch (error) {
      logDeduplicator.error('Error checking ownership:', { error: error instanceof Error ? error.message : String(error), id, userId });
      return false;
    }
  }

  /**
   * Vérifie si un utilisateur a le droit de modifier/supprimer un public good
   * (owner OU admin)
   */
  async checkOwnership(id: number, userId: number, userRole: string): Promise<void> {
    // Admin a tous les droits
    if (userRole === 'ADMIN') {
      return;
    }

    // Vérifier si l'utilisateur est propriétaire
    const isOwner = await this.isOwner(id, userId);
    if (!isOwner) {
      throw new PublicGoodPermissionError('You do not own this public good');
    }
  }

  /**
   * Override de getAll pour gérer le filtre par status par défaut (APPROVED)
   */
  async getAll(query: any) {
    try {
      // Par défaut, on filtre sur APPROVED si pas de status spécifié
      const params = { ...query };
      
      // Parser page et limit en numbers
      if (params.page) params.page = parseInt(params.page as string);
      if (params.limit) params.limit = parseInt(params.limit as string);
      
      if (!params.status || params.status === 'approved') {
        params.status = 'APPROVED' as ProjectStatus;
      } else if (params.status === 'pending') {
        params.status = 'PENDING' as ProjectStatus;
      } else if (params.status === 'rejected') {
        params.status = 'REJECTED' as ProjectStatus;
      } else if (params.status === 'all') {
        delete params.status; // Ne pas filtrer par status
      }

      const result = await this.repository.findAll(params);
      
      logDeduplicator.info('Public goods retrieved successfully', { 
        count: result.data.length,
        status: params.status || 'all'
      });
      
      return result;
    } catch (error) {
      logDeduplicator.error('Error fetching public goods:', { error: error instanceof Error ? error.message : String(error), query });
      throw error;
    }
  }
}

