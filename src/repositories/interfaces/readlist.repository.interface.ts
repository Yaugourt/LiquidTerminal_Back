import { 
  ReadListResponse, 
  ReadListCreateInput, 
  ReadListUpdateInput,
  ReadListSummaryResponse
} from '../../types/readlist.types';
import { BaseRepository } from './base.repository.interface';
import { BasePagination } from '../../types/common.types';

export interface ReadListRepository extends BaseRepository {
  /**
   * Récupère toutes les read lists avec pagination, tri et filtrage
   */
  findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    userId?: number;
    isPublic?: boolean;
  }): Promise<{
    data: ReadListSummaryResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Récupère une read list par son ID
   */
  findById(id: number): Promise<ReadListResponse | null>;

  /**
   * Récupère une read list par son ID (version summary sans items)
   */
  findSummaryById(id: number): Promise<ReadListSummaryResponse | null>;

  /**
   * Crée une nouvelle read list
   */
  create(data: ReadListCreateInput): Promise<ReadListResponse>;

  /**
   * Met à jour une read list existante
   */
  update(id: number, data: ReadListUpdateInput): Promise<ReadListResponse>;

  /**
   * Supprime une read list
   */
  delete(id: number): Promise<void>;

  /**
   * Vérifie si une read list existe avec le nom donné pour un utilisateur
   */
  existsByNameAndUser(name: string, userId: number): Promise<boolean>;

  /**
   * Récupère toutes les read lists d'un utilisateur
   */
  findByUser(userId: number): Promise<ReadListSummaryResponse[]>;

  /**
   * Récupère toutes les read lists publiques
   */
  findPublicLists(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
  }): Promise<{
    data: ReadListSummaryResponse[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }>;

  /**
   * Vérifie si un utilisateur a accès à une read list
   * (userId null = anonymous caller, granted only on public lists)
   */
  hasAccess(readListId: number, userId: number | null): Promise<boolean>;

  /**
   * Met à jour le nombre d'items dans une read list
   */
  updateItemsCount(readListId: number): Promise<void>;
} 