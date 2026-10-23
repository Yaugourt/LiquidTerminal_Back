import { 
  ReadListItemResponse, 
  ReadListItemCreateInput, 
  ReadListItemUpdateInput
} from '../../types/readlist.types';
import { BaseRepository } from './base.repository.interface';
import { BasePagination } from '../../types/common.types';

export interface ReadListItemRepository extends BaseRepository {
  /**
   * Récupère tous les items d'une read list avec pagination, tri et filtrage
   */
  findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    readListId?: number;
    isRead?: boolean;
  }): Promise<{
    data: ReadListItemResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Récupère un item de read list par son ID
   */
  findById(id: number): Promise<ReadListItemResponse | null>;

  /**
   * Crée un nouvel item de read list
   */
  create(data: ReadListItemCreateInput): Promise<ReadListItemResponse>;

  /**
   * Met à jour un item de read list existant
   */
  update(id: number, data: ReadListItemUpdateInput): Promise<ReadListItemResponse>;

  /**
   * Supprime un item de read list
   */
  delete(id: number): Promise<void>;

  /**
   * Récupère tous les items d'une read list spécifique
   */
  findByReadList(readListId: number, params?: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    isRead?: boolean;
  }): Promise<{
    data: ReadListItemResponse[];
    pagination: BasePagination;
  }>;

  /**
   * Vérifie si une ressource est déjà dans une read list
   */
  existsInReadList(readListId: number, resourceId: number): Promise<boolean>;

  /**
   * Marque un item comme lu/non lu
   */
  toggleReadStatus(id: number, isRead: boolean): Promise<ReadListItemResponse>;

  /**
   * Réorganise l'ordre des items dans une read list
   */
  reorderItems(readListId: number, itemOrders: { id: number; order: number }[]): Promise<void>;

  /**
   * Récupère le prochain ordre disponible pour une read list
   */
  getNextOrder(readListId: number): Promise<number>;

  /**
   * Supprime les items de toutes les read lists qui référencent une ressource
   * (la ressource vit en Content DB : pas de cascade FK possible). Retourne le nombre supprimé.
   */
  deleteByResourceId(resourceId: number): Promise<number>;

  /**
   * Supprime tous les items d'une read list
   */
  deleteByReadList(readListId: number): Promise<void>;

  /**
   * Compte le nombre d'items dans une read list
   */
  countByReadList(readListId: number): Promise<number>;

  /**
   * Compte le nombre d'items lus/non lus dans une read list
   */
  countByReadStatus(readListId: number, isRead: boolean): Promise<number>;
} 