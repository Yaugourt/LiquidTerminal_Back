import { BaseResponse, BasePagination } from './common.types';

// Types de base pour les WalletLists
export interface WalletListResponse {
  id: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
  isPublic: boolean;
  creator: {
    id: number;
    name: string | null;
  };
  items: WalletListItemResponse[];
}

// Types pour les opérations CRUD des WalletLists
export interface WalletListCreateInput {
  name: string;
  description?: string;
  userId: number;
  isPublic?: boolean;
}

export interface WalletListUpdateInput {
  name?: string;
  description?: string;
  isPublic?: boolean;
}

// Types de base pour les WalletListItems
export interface WalletListItemResponse {
  id: number;
  walletListId: number;
  userWalletId: number;
  addedAt: Date;
  notes: string | null;
  order: number | null;
  userWallet: {
    id: number;
    name: string | null;
    addedAt: Date;
    User: {
      id: number;
      name: string | null;
    };
    Wallet: {
      id: number;
      address: string;
      addedAt: Date;
    };
  };
}

// Types pour les opérations CRUD des WalletListItems
export interface WalletListItemCreateInput {
  walletListId?: number;
  userWalletId: number;
  notes?: string;
  order?: number;
}

export interface WalletListItemUpdateInput {
  notes?: string;
  order?: number;
}

// Types pour les réponses simplifiées (sans items pour les listes)
export interface WalletListSummaryResponse {
  id: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
  isPublic: boolean;
  creator: {
    id: number;
    name: string | null;
  };
  itemsCount: number;
}

// Types de réponse API
export interface WalletListResponseWrapper extends BaseResponse {
  data: WalletListResponse;
}

export interface WalletListsResponseWrapper extends BaseResponse {
  data: WalletListSummaryResponse[];
  pagination?: BasePagination;
}

export interface WalletListItemResponseWrapper extends BaseResponse {
  data: WalletListItemResponse;
}

export interface WalletListItemsResponseWrapper extends BaseResponse {
  data: WalletListItemResponse[];
  pagination?: BasePagination;
}
