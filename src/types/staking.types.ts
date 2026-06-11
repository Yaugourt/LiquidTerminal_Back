import { BaseResponse, BasePagination } from './common.types';

// Types de base pour les validateurs
export interface ValidatorSummary {
  validator: string;
  commission: string;
  description: string;
  isActive: boolean;
  isJailed: boolean;
  nRecentBlocks: number;
  name: string;
  signer: string;
  stake: number;
  unjailableAfter: number | null;
  stats: [string, { predictedApr: string; uptimeFraction: string }][];
}

export type ValidatorSummaries = ValidatorSummary[];

// Types pour les réponses API
export interface ValidatorSummariesResponse extends BaseResponse {
  data: ValidatorSummaries;
}

export interface TrendingValidatorsResponse extends BaseResponse {
  data: TrendingValidator[];
}

export interface ValidatorDetailsResponse extends BaseResponse {
  data: ValidatorDetails[];
  stats?: ValidatorOverallStats;
}

// Types pour les données formatées
export interface TrendingValidator {
  name: string;
  stake: number;
  apr: number;
  commission: number;
  uptime: number;
  isActive: boolean;
  nRecentBlocks: number;
}

export interface ValidatorDetails {
  name: string;
  validator: string;
  description: string;
  stake: number;
  apr: number;
  commission: number;
  uptime: number;
  isActive: boolean;
  nRecentBlocks: number;
}

export interface ValidatorStats {
  predictedApr: string;
  uptimeFraction: string;
}

export interface ValidatorOverallStats {
  totalValidators: number;
  activeValidators: number;
  totalHypeStaked: number;
}

// Types pour les actions de validation/delegation
export interface ValidationAction {
  type: string;
  signatureChainId: string;
  hyperliquidChain: string;
  validator: string;
  wei: number;
  isUndelegate: boolean;
  nonce: number;
}

export interface ValidationRawData {
  time: number;
  user: string;
  action: ValidationAction;
  block: number;
  hash: string;
  error: string | null;
}

export interface ValidationInfo {
  time: string; // ISO date string
  user: string;
  type: 'Delegate' | 'Undelegate';
  amount: number; // Converti depuis wei (divisé par 10^8)
  validator: string;
  hash: string;
}

// Types pour la pagination
export interface PaginationParams {
  page?: number;
  limit?: number;
}

// PaginatedResponse est maintenant importé de common.types.ts

export interface ValidationResponse extends BaseResponse {
  data: ValidationInfo[];
  pagination?: BasePagination;
}

// Types pour la queue de unstaking
export interface UnstakingQueueRawData {
  time: number;
  user: string;
  wei: number;
}

export interface UnstakingQueueInfo {
  time: string; // ISO date string
  user: string;
  amount: number; // Converti depuis wei (divisé par 10^8)
}

export interface UnstakingQueueResponse extends BaseResponse {
  data: UnstakingQueueInfo[];
  pagination?: BasePagination;
}

// Types pour les staked holders
export interface StakedHoldersData {
  token: string;
  lastUpdate: number;
  holders: Record<string, number>;
  holdersCount: number;
}

export interface StakedHolder {
  address: string;
  amount: number;
} 