/**
 * Purge Core ReadListItem rows whose EducationalResource no longer exists in the Content DB.
 *
 * Read list items (Core DB) reference resources (Content DB) by id only. The app removes
 * the items when a resource is deleted (EducationalResourceService.delete); this script
 * cleans up leftovers (failed cleanup, deletions made outside the app).
 *
 * Dry run by default. Usage:
 *   npx tsx scripts/purge-orphan-readlist-items.ts            # report only
 *   npx tsx scripts/purge-orphan-readlist-items.ts --apply    # delete the listed items
 *   npx tsx scripts/purge-orphan-readlist-items.ts --apply --force
 *
 * Aborts (exit 1) when the Content DB has 0 resources or when more than 50% of the items
 * look orphaned (likely a wrong CONTENT_DATABASE_URL; checked from 20 items up), unless
 * --force is passed.
 */
import 'dotenv/config';
import { prisma } from '../src/core/prisma.service';
import { prismaContent } from '../src/core/prisma.content.service';
import { planOrphanPurge } from '../src/utils/readlist-orphans';
import { chunkArray } from '../src/utils/chunk';

/** host/dbname only, never credentials */
function describeTarget(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');

  console.log(`Core DB:    ${describeTarget(process.env.DATABASE_URL)}`);
  console.log(`Content DB: ${describeTarget(process.env.CONTENT_DATABASE_URL)}`);
  console.log(`Mode:       ${apply ? 'APPLY' : 'dry run'}${force ? ' (force)' : ''}`);

  const items = await prisma.readListItem.findMany({
    select: { id: true, readListId: true, resourceId: true },
    orderBy: { id: 'asc' }
  });
  const contentResourceCount = await prismaContent.educationalResource.count();

  const existingResourceIds = new Set<number>();
  const resourceIds = Array.from(new Set(items.map((item) => item.resourceId)));
  for (const chunk of chunkArray(resourceIds, 5000)) {
    const rows = await prismaContent.educationalResource.findMany({
      where: { id: { in: chunk } },
      select: { id: true }
    });
    for (const row of rows) existingResourceIds.add(row.id);
  }

  const plan = planOrphanPurge({ items, existingResourceIds, contentResourceCount, force });
  console.log(`Items: ${plan.totalItems}, Content resources: ${contentResourceCount}, orphans: ${plan.orphans.length}`);

  if (plan.orphans.length === 0) {
    console.log('Nothing to purge.');
    return 0;
  }

  console.log('Orphans per read list:');
  for (const [readListId, count] of Object.entries(plan.countsByReadList)) {
    console.log(`  read list ${readListId}: ${count}`);
  }
  const ids = plan.orphans.map((o) => o.id);
  const shown = ids.slice(0, 50).join(', ');
  console.log(`Orphan item ids: ${shown}${ids.length > 50 ? `, and ${ids.length - 50} more` : ''}`);

  if (plan.abortReason) {
    console.error(`ABORT: ${plan.abortReason}`);
    return 1;
  }
  if (!apply) {
    console.log('Dry run: nothing deleted. Re-run with --apply to delete exactly these items.');
    return 0;
  }

  let count = 0;
  for (const chunk of chunkArray(ids, 5000)) {
    const res = await prisma.readListItem.deleteMany({ where: { id: { in: chunk } } });
    count += res.count;
  }
  console.log(`Deleted ${count} read list item(s).`);
  return 0;
}

main()
  .then(async (code) => {
    await Promise.allSettled([prisma.$disconnect(), prismaContent.$disconnect()]);
    process.exit(code);
  })
  .catch(async (error) => {
    console.error('Purge failed:', error instanceof Error ? error.message : error);
    await Promise.allSettled([prisma.$disconnect(), prismaContent.$disconnect()]);
    process.exit(1);
  });
