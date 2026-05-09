import { PublicGoodResponse, PublicGoodCreateInput, PublicGoodUpdateInput } from '../../types/publicgood.types';
import { BaseRepository } from './base.repository.interface';
import { BasePagination } from '../../types/common.types';
import { ProjectStatus } from '../../types/prisma-enums';

export interface PublicGoodRepository extends BaseRepository {
  /**
   * Récupère tous les public goods avec pagination, tri et filtrage
   */
  findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    status?: ProjectStatus;
    category?: string;
    developmentStatus?: string;
  }): Promise<{
    data: PublicGoodResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Récupère un public good par son ID
   */
  findById(id: number): Promise<PublicGoodResponse | null>;

  /**
   * Crée un nouveau public good
   */
  create(data: PublicGoodCreateInput): Promise<PublicGoodResponse>;

  /**
   * Met à jour un public good existant
   */
  update(id: number, data: PublicGoodUpdateInput): Promise<PublicGoodResponse>;

  /**
   * Supprime un public good
   */
  delete(id: number): Promise<void>;

  /**
   * Vérifie si un public good existe avec le nom donné
   */
  existsByName(name: string): Promise<boolean>;

  /**
   * Récupère tous les public goods soumis par un utilisateur
   */
  findBySubmitter(submitterId: number, params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
  }): Promise<{
    data: PublicGoodResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Récupère tous les public goods en attente de review
   */
  findPending(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
  }): Promise<{
    data: PublicGoodResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Review un public good (MODERATOR/ADMIN)
   */
  review(id: number, reviewData: {
    status: ProjectStatus;
    reviewerId: number;
    reviewNotes?: string;
  }): Promise<PublicGoodResponse>;

  /**
   * Vérifie si un utilisateur est propriétaire d'un public good
   */
  isOwner(id: number, userId: number): Promise<boolean>;
}

