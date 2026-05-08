/**
 * Prisma enum facade.
 *
 * After the multi-DB split, enums live in the Prisma client of the database
 * that owns them. Importing directly from `@prisma/client`,
 * `../../prisma-content/generated/client`, or
 * `../../prisma-telegram/generated/client` everywhere would scatter ~40 imports
 * across the codebase.
 *
 * This file is the SINGLE source of truth for enum imports in app code.
 * Always import enums from `@/types/prisma-enums` (or the relative path), never
 * directly from the generated clients.
 */

// Core DB enums (default Prisma client)
export {
  UserRole,
  XpActionType,
  DailyTaskType,
  WeeklyChallengeType,
} from '@prisma/client';

// Content DB enums
export {
  ProjectStatus,
  ResourceStatus,
  DevelopmentStatus,
  TeamSize,
  ExperienceLevel,
  SupportType,
  ContributorType,
  BudgetRange,
} from '../../prisma-content/generated/client';

// Telegram DB enums
export { WalletEventType } from '../../prisma-telegram/generated/client';
