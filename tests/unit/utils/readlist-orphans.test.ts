import { planOrphanPurge, ReadListItemRef } from '../../../src/utils/readlist-orphans';

const item = (id: number, readListId: number, resourceId: number): ReadListItemRef => ({ id, readListId, resourceId });
/** n items on n distinct resources 1..n, in one read list */
const many = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1, 1, i + 1));
const existing = (from: number, to: number) => new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i));

describe('planOrphanPurge', () => {
  const items = [item(1, 10, 100), item(2, 10, 101), item(3, 11, 101), item(4, 11, 102), item(5, 12, 100)];

  it('flags the items whose resource is missing from Content, counted per read list', () => {
    const plan = planOrphanPurge({ items, existingResourceIds: new Set([100, 102]), contentResourceCount: 460 });

    expect(plan.orphans.map((o) => o.id)).toEqual([2, 3]);
    expect(plan.countsByReadList).toEqual({ 10: 1, 11: 1 });
    expect(plan.totalItems).toBe(5);
    expect(plan.abortReason).toBeNull();
  });

  it('reports nothing when every resource exists', () => {
    const plan = planOrphanPurge({ items, existingResourceIds: new Set([100, 101, 102]), contentResourceCount: 3 });

    expect(plan.orphans).toEqual([]);
    expect(plan.abortReason).toBeNull();
  });

  it('aborts when the Content DB is empty', () => {
    const plan = planOrphanPurge({ items, existingResourceIds: new Set(), contentResourceCount: 0 });

    expect(plan.orphans).toHaveLength(5);
    expect(plan.abortReason).toMatch(/0 educational resources/);
  });

  it('aborts when more than 50% of the items look orphaned', () => {
    // 20 items, resources 1..9 exist: 11 orphans (55%)
    const plan = planOrphanPurge({ items: many(20), existingResourceIds: existing(1, 9), contentResourceCount: 460 });

    expect(plan.orphans).toHaveLength(11);
    expect(plan.abortReason).toMatch(/55%/);
  });

  it('does not abort at exactly 50%', () => {
    const plan = planOrphanPurge({ items: many(20), existingResourceIds: existing(1, 10), contentResourceCount: 460 });

    expect(plan.orphans).toHaveLength(10);
    expect(plan.abortReason).toBeNull();
  });

  it('leaves small sets to the empty-Content guard only', () => {
    // 5 items, 3 orphans (60%): a handful of real orphans, not a wrong database
    const plan = planOrphanPurge({ items, existingResourceIds: new Set([100]), contentResourceCount: 460 });

    expect(plan.orphans).toHaveLength(3);
    expect(plan.abortReason).toBeNull();
  });

  it('--force lifts both guards', () => {
    const empty = planOrphanPurge({ items, existingResourceIds: new Set(), contentResourceCount: 0, force: true });
    const majority = planOrphanPurge({ items: many(20), existingResourceIds: existing(1, 9), contentResourceCount: 460, force: true });

    expect(empty.abortReason).toBeNull();
    expect(majority.abortReason).toBeNull();
    expect(majority.orphans).toHaveLength(11);
  });

  it('has nothing to abort when there are no items at all', () => {
    const plan = planOrphanPurge({ items: [], existingResourceIds: new Set(), contentResourceCount: 0 });

    expect(plan.orphans).toEqual([]);
    expect(plan.abortReason).toBeNull();
  });
});
