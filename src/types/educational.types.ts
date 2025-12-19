import { BaseResponse, BasePagination } from './common.types';
import { ResourceStatus } from '@prisma/client';

// Types de base pour les catégories éducatives
export interface EducationalCategoryResponse {
  id: number;
  name: string;
  description: string | null;
  createdAt: Date;
  createdBy: number;
  creator: {
    id: number;
    name: string | null;
    email: string | null;
  };
}

// Types pour les opérations CRUD des catégories éducatives
export interface EducationalCategoryCreateInput {
  name: string;
  description?: string;
  createdBy: number;
}

export interface EducationalCategoryUpdateInput {
  name?: string;
  description?: string;
}

// Types de base pour les ressources éducatives
export interface EducationalResourceResponse {
  id: number;
  url: string;
  createdAt: Date;
  addedBy: number;
  linkPreviewId?: string;

  // Moderation fields
  status: ResourceStatus;
  reviewedAt?: Date;
  reviewedBy?: number;
  reviewNotes?: string;
  reviewer?: {
    id: number;
    name: string | null;
  } | null;

  creator: {
    id: number;
    name: string | null;
    email: string | null;
  };
  categories: EducationalResourceCategoryResponse[];
}

// Types pour les opérations CRUD des ressources éducatives
export interface EducationalResourceCreateInput {
  url: string;
  addedBy: number;
  categoryIds?: number[];
}

export interface EducationalResourceUpdateInput {
  url?: string;
  linkPreviewId?: string;
}

// Types pour la table de liaison
export interface EducationalResourceCategoryResponse {
  id: number;
  resourceId: number;
  categoryId: number;
  assignedAt: Date;
  assignedBy: number | null;
  category: {
    id: number;
    name: string;
    description: string | null;
  };
  assigner?: {
    id: number;
    name: string | null;
    email: string | null;
  } | null;
}

export interface EducationalResourceCategoryCreateInput {
  resourceId: number;
  categoryId: number;
  assignedBy?: number;
}



// Types de réponse API
export interface EducationalCategoryResponseWrapper extends BaseResponse {
  data: EducationalCategoryResponse;
}

export interface EducationalCategoriesResponseWrapper extends BaseResponse {
  data: EducationalCategoryResponse[];
  pagination?: BasePagination;
}

export interface EducationalResourceResponseWrapper extends BaseResponse {
  data: EducationalResourceResponse;
}

export interface EducationalResourcesResponseWrapper extends BaseResponse {
  data: EducationalResourceResponse[];
  pagination?: BasePagination;
}

// ==================== MODERATION TYPES ====================

export interface ResourceReviewInput {
  status: 'APPROVED' | 'REJECTED';
  notes?: string;
}

export interface ResourceSubmitInput {
  url: string;
  addedBy: number;
  categoryIds?: number[];
}

// ==================== REPORT TYPES ====================

export interface ResourceReportInput {
  resourceId: number;
  reportedBy: number;
  reason: string;
}

export interface ResourceReportResponse {
  id: number;
  resourceId: number;
  reportedBy: number;
  reason: string;
  createdAt: Date;
  reporter: {
    id: number;
    name: string | null;
  };
  resource?: {
    id: number;
    url: string;
    status: ResourceStatus;
  };
}

export interface ResourceReportResponseWrapper extends BaseResponse {
  data: ResourceReportResponse;
}

export interface ResourceReportsResponseWrapper extends BaseResponse {
  data: ResourceReportResponse[];
  pagination?: BasePagination;
}