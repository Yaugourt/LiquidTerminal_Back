/**
 * Pure decision logic for scripts/purge-orphan-readlist-items.ts.
 *
 * ReadListItem rows live in the Core DB and reference an EducationalResource that lives
 * in the Content DB by id only (no cross-DB FK), so a resource deletion that was not
 * followed by the Core cleanup leaves orphan items. Kept free of any DB import so it is
 * unit-testable.
 */

export interface ReadListItemRef {
  id: number;
  readListId: number;
  resourceId: number;
}

export interface OrphanPlan {
  /** Items whose resourceId has no row in the Content DB */
  orphans: ReadListItemRef[];
  /** Orphan count per read list id */
  countsByReadList: Record<number, number>;
  totalItems: number;
  /** Non-null when the purge must not run (unless forced); the message says why */
  abortReason: string | null;
}

/** Orphans above this share of all items look like a misconfigured Content DB, not stale rows. */
export const MAX_ORPHAN_RATIO = 0.5;
/** Below this many items a few real orphans can exceed the ratio, so only the empty-Content guard applies. */
export const MIN_ITEMS_FOR_RATIO_GUARD = 20;

export function planOrphanPurge(params: {
  items: ReadListItemRef[];
  /** Subset of the items' resourceIds that exist in the Content DB */
  existingResourceIds: ReadonlySet<number>;
  /** Total number of EducationalResource rows in the Content DB */
  contentResourceCount: number;
  force?: boolean;
}): OrphanPlan {
  const { items, existingResourceIds, contentResourceCount, force = false } = params;

  const orphans = items.filter((item) => !existingResourceIds.has(item.resourceId));
  const countsByReadList: Record<number, number> = {};
  for (const orphan of orphans) {
    countsByReadList[orphan.readListId] = (countsByReadList[orphan.readListId] ?? 0) + 1;
  }

  let abortReason: string | null = null;
  if (!force && orphans.length > 0) {
    if (contentResourceCount === 0) {
      abortReason =
        'The Content DB has 0 educational resources: likely a misconfigured CONTENT_DATABASE_URL (every item would look orphaned). Use --force to override.';
    } else if (items.length >= MIN_ITEMS_FOR_RATIO_GUARD && orphans.length > items.length * MAX_ORPHAN_RATIO) {
      abortReason =
        `${orphans.length} of ${items.length} items (${Math.round((orphans.length / items.length) * 100)}%) look orphaned, ` +
        `above the ${MAX_ORPHAN_RATIO * 100}% safety threshold: check the Content DB target. Use --force to override.`;
    }
  }

  return { orphans, countsByReadList, totalItems: items.length, abortReason };
}
