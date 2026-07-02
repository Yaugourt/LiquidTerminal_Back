import { BaseResponse, PaginatedResponse, BasePagination } from './common.types';

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

// ─── Validator L1 votes (governance) ───

// Raw snapshot element from HL info { type: "validatorL1Votes" }.
// `action` is a polymorphic L1 action (a tagged union we do not fully model);
// it is summarised defensively in the service.
export interface ValidatorL1Vote {
  expireTime: number; // epoch ms — voting window close
  action: Record<string, unknown>;
  votes: string[]; // validator addresses (JOIN on `validator`, NOT signer)
  quorumReached: boolean;
}

// One voter, joined to its validator summary.
export interface VoteParticipant {
  validator: string; // 0x address
  name: string;
  stake: number; // HYPE (wei / 10^8)
  isFoundation: boolean;
}

// A pending proposal enriched server-side (join + Foundation stamp + weights).
export interface ValidatorVoteInfo {
  id: number; // index within the current snapshot (no upstream id)
  actionType: string; // best-effort label, e.g. "settleOutcome"
  summary: string | null; // action details when present, else null
  expireTime: number; // epoch ms
  quorumReached: boolean;
  voterCount: number; // matched voters
  totalValidators: number;
  participationPct: number; // voterCount / totalValidators * 100
  votingStake: number; // HYPE backing this proposal
  stakeWeightPct: number; // votingStake / totalStake * 100 (incl. Foundation)
  stakeWeightExFoundationPct: number; // community-only stake weight
  foundationVoterCount: number; // how many of the voters are Foundation
  voters: VoteParticipant[];
}

// Overall snapshot context (single-sourced Foundation split).
export interface ValidatorVotesStats {
  totalValidators: number;
  totalStake: number; // HYPE
  foundationStake: number; // HYPE
  communityStake: number; // HYPE
  pendingCount: number;
  lastUpdate: number; // epoch ms
}

export interface ValidatorVotesResponse extends BaseResponse {
  data: ValidatorVoteInfo[];
  stats: ValidatorVotesStats;
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