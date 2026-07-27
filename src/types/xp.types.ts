import { XpActionType } from '@prisma/client';

export interface XpTransactionResponse {
  id: number;
  userId: number;
  actionType: XpActionType;
  xpAmount: number;
  referenceId: string | null;
  description: string | null;
  createdAt: Date;
}

export interface UserXpStats {
  totalXp: number;
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
  progressPercent: number;
  xpToNextLevel: number;
  loginStreak: number;
  lastLoginAt: Date | null;
}

export interface XpLeaderboardEntry {
  rank: number;
  // Internal sequential User.id intentionally NOT exposed here: a public
  // leaderboard needs only rank + display name, and leaking the id gave an
  // enumeration/correlation handle across features.
  name: string | null;
  totalXp: number;
  level: number;
}

export interface XpLeaderboardResponse {
  leaderboard: XpLeaderboardEntry[];
  userRank?: number;
  total: number;
}

export interface GrantXpInput {
  userId: number;
  actionType: XpActionType;
  referenceId?: string;
  description?: string;
  customXpAmount?: number; // Pour ADMIN_BONUS/PENALTY
}

export interface XpTransactionHistoryQuery {
  page?: number;
  limit?: number;
  actionType?: XpActionType;
}

export interface XpTransactionHistoryResponse {
  transactions: XpTransactionResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}





