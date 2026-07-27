/**
 * Cross-DB enrichment helpers.
 *
 * After the multi-DB split, Content and Telegram tables can no longer Prisma
 * `include` User rows (User lives in Core DB). These helpers do the fan-out:
 * (1) collect user IDs from rows, (2) `findMany` on Core User, (3) merge into
 * the original rows under the field name expected by the frontend.
 *
 * The shapes returned MUST match the frontend's hand-written types exactly —
 * any divergence breaks the UI. See cross-db enrichment table in plan file.
 */

import { prisma } from '../core/prisma.service';

// ---------- User selectors ------------
// Both are email-free on purpose. Enriched user objects (creator / submittedBy /
// reviewedBy / item owner) ride along on PUBLIC, unauthenticated list responses,
// so exposing email here leaked every registered user's address to anonymous
// scrapers. Moderator tooling that genuinely needs a submitter's contact must
// go through a separate authenticated endpoint, not this shared projection.

const USER_SELECT_FULL = { id: true, name: true } as const;
const USER_SELECT_MINIMAL = { id: true, name: true } as const;

export type UserFull = { id: number; name: string | null };
export type UserMinimal = { id: number; name: string | null };

// ---------- Internal: batched User lookup (deduped, single round-trip) ----

async function fetchUsersFull(userIds: number[]): Promise<Map<number, UserFull>> {
  const unique = Array.from(new Set(userIds.filter((id): id is number => typeof id === 'number')));
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: USER_SELECT_FULL,
  });
  return new Map(users.map((u: UserFull) => [u.id, u]));
}

async function fetchUsersMinimal(userIds: number[]): Promise<Map<number, UserMinimal>> {
  const unique = Array.from(new Set(userIds.filter((id): id is number => typeof id === 'number')));
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: USER_SELECT_MINIMAL,
  });
  return new Map(users.map((u: UserMinimal) => [u.id, u]));
}

// ---------- attachCreator -------------------------------------------------
// Used by: EducationalResource (addedBy → creator), EducationalCategory
// (createdBy → creator), ReadList (userId → creator). Frontend expects
// creator = { id, name, email }.

export async function attachCreator<T extends Record<string, unknown>, K extends keyof T>(
  rows: T[],
  idField: K,
): Promise<Array<T & { creator: UserFull | null }>> {
  const ids = rows.map((r) => r[idField] as number);
  const users = await fetchUsersFull(ids);
  return rows.map((r) => ({
    ...r,
    creator: users.get(r[idField] as number) ?? null,
  }));
}

// ---------- attachReviewer (minimal — no email per frontend types) ---------
// Used by: EducationalResource (reviewedBy → reviewer). Frontend expects
// reviewer = { id, name } | null.

export async function attachReviewer<
  T extends Record<string, unknown>,
  K extends keyof T,
>(rows: T[], idField: K): Promise<Array<T & { reviewer: UserMinimal | null }>> {
  const ids = rows.map((r) => r[idField] as number | null).filter((id): id is number => id != null);
  const users = await fetchUsersMinimal(ids);
  return rows.map((r) => {
    const id = r[idField] as number | null;
    return { ...r, reviewer: id != null ? (users.get(id) ?? null) : null };
  });
}

// ---------- attachAssigner ------------------------------------------------
// Used by: EducationalResourceCategory (assignedBy → assigner). Frontend
// expects assigner = { id, name } | null.

export async function attachAssigner<
  T extends Record<string, unknown>,
  K extends keyof T,
>(rows: T[], idField: K): Promise<Array<T & { assigner: UserMinimal | null }>> {
  const ids = rows.map((r) => r[idField] as number | null).filter((id): id is number => id != null);
  const users = await fetchUsersMinimal(ids);
  return rows.map((r) => {
    const id = r[idField] as number | null;
    return { ...r, assigner: id != null ? (users.get(id) ?? null) : null };
  });
}

// ---------- attachReporter ------------------------------------------------
// Used by: ResourceReport (reportedBy → reporter). Frontend expects
// reporter = { id, name } (always present — reportedBy is non-null in DB).

export async function attachReporter<
  T extends Record<string, unknown>,
  K extends keyof T,
>(rows: T[], idField: K): Promise<Array<T & { reporter: UserMinimal | null }>> {
  const ids = rows.map((r) => r[idField] as number);
  const users = await fetchUsersMinimal(ids);
  return rows.map((r) => ({
    ...r,
    reporter: users.get(r[idField] as number) ?? null,
  }));
}

// ---------- attachSubmitter / attachReviewedBy (PublicGood) ---------------
// Frontend expects submittedBy = { id, name, email } (always),
// reviewedBy = { id, name, email } | null.

export async function attachSubmitter<
  T extends Record<string, unknown>,
  K extends keyof T,
>(rows: T[], idField: K): Promise<Array<T & { submittedBy: UserFull | null }>> {
  const ids = rows.map((r) => r[idField] as number);
  const users = await fetchUsersFull(ids);
  return rows.map((r) => ({
    ...r,
    submittedBy: users.get(r[idField] as number) ?? null,
  }));
}

export async function attachReviewedBy<
  T extends Record<string, unknown>,
  K extends keyof T,
>(rows: T[], idField: K): Promise<Array<T & { reviewedBy: UserFull | null }>> {
  const ids = rows.map((r) => r[idField] as number | null).filter((id): id is number => id != null);
  const users = await fetchUsersFull(ids);
  return rows.map((r) => {
    const id = r[idField] as number | null;
    return { ...r, reviewedBy: id != null ? (users.get(id) ?? null) : null };
  });
}

// ---------- Single-row convenience helpers --------------------------------

export async function attachCreatorOne<T extends Record<string, unknown>, K extends keyof T>(
  row: T | null,
  idField: K,
): Promise<(T & { creator: UserFull | null }) | null> {
  if (!row) return null;
  const [enriched] = await attachCreator([row], idField);
  return enriched;
}

export async function attachSubmitterAndReviewerOne<T extends Record<string, unknown>>(
  row: T | null,
  submitterField: keyof T,
  reviewerField: keyof T,
): Promise<(T & { submittedBy: UserFull | null; reviewedBy: UserFull | null }) | null> {
  if (!row) return null;
  const submitterId = row[submitterField] as number | null;
  const reviewerId = row[reviewerField] as number | null;
  const ids = [submitterId, reviewerId].filter((id): id is number => typeof id === 'number');
  const users = await fetchUsersFull(ids);
  return {
    ...row,
    submittedBy: submitterId != null ? (users.get(submitterId) ?? null) : null,
    reviewedBy: reviewerId != null ? (users.get(reviewerId) ?? null) : null,
  };
}
