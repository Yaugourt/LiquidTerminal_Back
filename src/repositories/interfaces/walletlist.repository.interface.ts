import { 
  WalletListResponse, 
  WalletListCreateInput, 
  WalletListUpdateInput,
  WalletListSummaryResponse
} from '../../types/walletlist.types';
import { BaseRepository } from './base.repository.interface';
import { BasePagination } from '../../types/common.types';

export interface WalletListRepository extends BaseRepository {
  /**
   * Récupère toutes les wallet lists avec pagination, tri et filtrage
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
    data: WalletListSummaryResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Récupère une wallet list par son ID
   */
  findById(id: number): Promise<WalletListResponse | null>;

  /**
   * Récupère une wallet list par son ID (version summary sans items)
   */
  findSummaryById(id: number): Promise<WalletListSummaryResponse | null>;

  /**
   * Crée une nouvelle wallet list
   */
  create(data: WalletListCreateInput): Promise<WalletListResponse>;

  /**
   * Met à jour une wallet list existante
   */
  update(id: number, data: WalletListUpdateInput): Promise<WalletListResponse>;

  /**
   * Supprime une wallet list
   */
  delete(id: number): Promise<void>;

  /**
   * Vérifie si une wallet list existe avec le nom donné pour un utilisateur
   */
  existsByNameAndUser(name: string, userId: number): Promise<boolean>;

  /**
   * Récupère toutes les wallet lists d'un utilisateur
   */
  findByUser(userId: number): Promise<WalletListSummaryResponse[]>;

  /**
   * Compte le nombre de wallet lists d'un utilisateur
   */
  countByUser(userId: number): Promise<number>;

  /**
   * Récupère toutes les wallet lists publiques
   */
  findPublicLists(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
  }): Promise<{
    data: WalletListSummaryResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Vérifie si un utilisateur a accès EN LECTURE à une wallet list (propriétaire OU liste publique)
   */
  hasAccess(walletListId: number, userId: number): Promise<boolean>;

  /**
   * Vérifie si l'utilisateur est le PROPRIÉTAIRE de la wallet list (pour les écritures)
   */
  isOwner(walletListId: number, userId: number): Promise<boolean>;

  /**
   * Met à jour le nombre d'items dans une wallet list
   */
  updateItemsCount(walletListId: number): Promise<void>;
}
