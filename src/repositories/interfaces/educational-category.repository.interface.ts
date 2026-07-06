import {
  EducationalCategoryResponse,
  EducationalCategoryCreateInput,
  EducationalCategoryUpdateInput
} from '../../types/educational.types';
import { BaseRepository } from './base.repository.interface';
import { BasePagination } from '../../types/common.types';
import { ResourceStatus } from '../../types/prisma-enums';

export interface EducationalCategoryRepository extends BaseRepository {
  /**
   * Récupère toutes les catégories éducatives avec pagination, tri et filtrage
   */
  findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    createdBy?: number;
  }): Promise<{
    data: EducationalCategoryResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Récupère une catégorie éducative par son ID
   */
  findById(id: number): Promise<EducationalCategoryResponse | null>;



  /**
   * Crée une nouvelle catégorie éducative
   */
  create(data: EducationalCategoryCreateInput): Promise<EducationalCategoryResponse>;

  /**
   * Met à jour une catégorie éducative existante
   */
  update(id: number, data: EducationalCategoryUpdateInput): Promise<EducationalCategoryResponse>;

  /**
   * Supprime une catégorie éducative
   */
  delete(id: number): Promise<void>;

  /**
   * Vérifie si une catégorie éducative existe avec le nom donné
   */
  existsByName(name: string): Promise<boolean>;

  /**
   * Récupère toutes les ressources d'une catégorie éducative (optionnellement filtrées par statut)
   */
  getResourcesByCategory(categoryId: number, status?: ResourceStatus): Promise<any[]>;

  /**
   * Compte les ressources par catégorie (optionnellement filtrées par statut) en un seul groupBy
   */
  countResourcesByCategory(status?: ResourceStatus): Promise<Map<number, number>>;

  /**
   * Récupère les catégories éducatives créées par un utilisateur
   */
  findByCreator(userId: number): Promise<EducationalCategoryResponse[]>;

  /**
   * Trouve une catégorie éducative par son nom
   */
  findByName(name: string): Promise<EducationalCategoryResponse | null>;
} 