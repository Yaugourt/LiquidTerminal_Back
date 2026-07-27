import { BaseResponse, BasePagination } from './common.types';
import {
  ProjectStatus,
  DevelopmentStatus,
  TeamSize,
  ExperienceLevel,
  SupportType,
  BudgetRange,
  ContributorType
} from './prisma-enums';

// Type de base pour PublicGood
export interface PublicGood {
  id: number;
  createdAt: Date;
  updatedAt: Date;

  // Section 1: Le projet
  name: string;
  description: string;
  githubUrl: string;
  demoUrl: string | null;
  websiteUrl: string | null;
  category: string;
  discordContact: string | null;
  telegramContact: string | null;

  // Visuels
  logo: string | null;
  banner: string | null;
  screenshots: string[];

  // Section 2: Impact HyperLiquid
  problemSolved: string;
  targetUsers: string[];
  hlIntegration: string;
  developmentStatus: DevelopmentStatus;

  // Section 3: Équipe & Technique
  leadDeveloperName: string;
  leadDeveloperContact: string;
  teamSize: TeamSize;
  experienceLevel: ExperienceLevel;
  technologies: string[];

  // Section 4: Soutien demandé (optionnel)
  supportTypes: SupportType[];
  contributorTypes: ContributorType[];
  budgetRange: BudgetRange | null;

  // Métadonnées
  status: ProjectStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewerId: number | null;
  reviewNotes: string | null;
  submitterId: number;
}

// Type de réponse avec relations
export interface PublicGoodResponse extends PublicGood {
  submittedBy: {
    id: number;
    name: string | null;
  };
  reviewedBy?: {
    id: number;
    name: string | null;
  } | null;
}

// Type pour création
export interface PublicGoodCreateInput {
  // Section 1: Le projet
  name: string;
  description: string;
  githubUrl: string;
  demoUrl?: string;
  websiteUrl?: string;
  category: string;
  discordContact?: string;
  telegramContact?: string;

  // Visuels (optionnels car gérés par upload)
  logo?: string;
  banner?: string;
  screenshots?: string[];

  // Section 2: Impact HyperLiquid
  problemSolved: string;
  targetUsers: string[];
  hlIntegration: string;
  developmentStatus: DevelopmentStatus;

  // Section 3: Équipe & Technique
  leadDeveloperName: string;
  leadDeveloperContact: string;
  teamSize: TeamSize;
  experienceLevel: ExperienceLevel;
  technologies: string[];

  // Section 4: Soutien demandé (optionnel)
  supportTypes?: SupportType[];
  contributorTypes?: ContributorType[];
  budgetRange?: BudgetRange;

  // User qui soumet (injecté par le controller)
  submitterId?: number;
}

// Type pour mise à jour (tous les champs optionnels)
export interface PublicGoodUpdateInput {
  // Section 1: Le projet
  name?: string;
  description?: string;
  githubUrl?: string;
  demoUrl?: string;
  websiteUrl?: string;
  category?: string;
  discordContact?: string;
  telegramContact?: string;

  // Visuels
  logo?: string;
  banner?: string;
  screenshots?: string[];

  // Section 2: Impact HyperLiquid
  problemSolved?: string;
  targetUsers?: string[];
  hlIntegration?: string;
  developmentStatus?: DevelopmentStatus;

  // Section 3: Équipe & Technique
  leadDeveloperName?: string;
  leadDeveloperContact?: string;
  teamSize?: TeamSize;
  experienceLevel?: ExperienceLevel;
  technologies?: string[];

  // Section 4: Soutien demandé
  supportTypes?: SupportType[];
  contributorTypes?: ContributorType[];
  budgetRange?: BudgetRange;
}

// Type pour review
export interface PublicGoodReviewInput {
  status: 'APPROVED' | 'REJECTED';
  reviewNotes?: string;
}

// Type pour les paramètres de query
export interface PublicGoodQueryParams {
  page?: number;
  limit?: number;
  status?: string; // 'pending' | 'approved' | 'rejected' | 'all'
  category?: string;
  search?: string;
  developmentStatus?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

// Types de réponse API
export interface PublicGoodResponseWrapper extends BaseResponse {
  data: PublicGoodResponse;
}

export interface PublicGoodsResponseWrapper extends BaseResponse {
  data: PublicGoodResponse[];
  pagination: BasePagination;
}

