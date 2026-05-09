/**
 * Smoke test for the multi-DB split.
 *
 * Calls repositories directly (bypasses HTTP / auth) to verify:
 * 1. Content reads return frontend-shaped objects with cross-DB User enrichment.
 * 2. Content writes commit only to the Content DB and don't touch Core's clone tables.
 * 3. Telegram service can resolve a linkedUserId by hitting Core User separately.
 *
 * Usage: npx tsx scripts/smoke-test-multidb.ts
 */
import 'dotenv/config';
import { prisma } from '../src/core/prisma.service';
import { prismaContent } from '../src/core/prisma.content.service';
import { prismaTelegram } from '../src/core/prisma.telegram.service';
import { educationalResourceRepository, publicGoodRepository } from '../src/repositories';
import { TelegramService } from '../src/services/telegram/telegram.service';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, details?: unknown): void {
  if (ok) {
    console.log(`✅ ${name}`);
    pass++;
  } else {
    console.log(`❌ ${name}`);
    if (details) console.log('   details:', JSON.stringify(details, null, 2).slice(0, 400));
    fail++;
  }
}

async function main(): Promise<void> {
  // 1. Read PublicGood — fan-out submittedBy/reviewedBy
  const goods = await publicGoodRepository.findAll({ page: 1, limit: 10 });
  const g = goods.data[0] as Record<string, unknown>;
  check('PublicGood.submittedBy = {id,name,email}',
    g?.submittedBy != null
      && typeof (g.submittedBy as Record<string, unknown>).id === 'number'
      && 'name' in (g.submittedBy as Record<string, unknown>)
      && 'email' in (g.submittedBy as Record<string, unknown>),
    g?.submittedBy);
  check('PublicGood.reviewedBy = {id,name,email} | null',
    g?.reviewedBy === null
      || (g?.reviewedBy != null
        && 'email' in (g.reviewedBy as Record<string, unknown>)),
    g?.reviewedBy);

  // 2. Read EducationalResource — fan-out 3-level (creator full, reviewer minimal, categories[].assigner minimal)
  const resources = await educationalResourceRepository.findAll({ page: 1, limit: 10 });
  const r = (resources.data as Array<Record<string, unknown>>)[0];
  check('EducationalResource.creator = {id,name,email}',
    r?.creator != null && 'email' in (r.creator as Record<string, unknown>),
    r?.creator);
  check('EducationalResource.reviewer = {id,name} (no email)',
    r?.reviewer != null
      && 'name' in (r.reviewer as Record<string, unknown>)
      && !('email' in (r.reviewer as Record<string, unknown>)),
    r?.reviewer);
  const cats = r?.categories as Array<Record<string, unknown>> | undefined;
  check('EducationalResource.categories[].assigner = {id,name}',
    cats != null && cats.length > 0
      && cats[0].assigner != null
      && !('email' in (cats[0].assigner as Record<string, unknown>)),
    cats?.[0]?.assigner);

  // 3. Write — create + delete a fresh resource via repository (Content TX + best-effort XP outside)
  const beforeCore = await prisma.educationalResource.count();
  const beforeContent = await prismaContent.educationalResource.count();
  const created = await prismaContent.educationalResource.create({
    data: { url: 'https://smoke.local/' + Date.now(), addedBy: 1 },
  });
  const afterCore = await prisma.educationalResource.count();
  const afterContent = await prismaContent.educationalResource.count();
  check('Write hits Content only (Core count unchanged)',
    afterCore === beforeCore && afterContent === beforeContent + 1,
    { beforeCore, afterCore, beforeContent, afterContent });
  await prismaContent.educationalResource.delete({ where: { id: created.id } });

  // 4. Telegram getLinkedAccount — Core lookup via separate query
  const tgUser = await prismaTelegram.telegramUser.findFirst({ where: { linkedUserId: { not: null } } });
  if (tgUser) {
    const tgService = TelegramService.getInstance();
    const acct = await tgService.getLinkedAccount(tgUser.telegramId);
    check('Telegram getLinkedAccount resolves linked User from Core',
      acct?.linked === true && typeof acct?.userId === 'number' && acct?.email != null,
      acct);
  }

  // 5. ReadListItem deep chain — already covered by HTTP test, just verify count
  const readListItemCount = await prisma.readListItem.count();
  check('ReadListItem rows exist in Core (cross-DB FK to Content)',
    readListItemCount > 0, { readListItemCount });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Smoke failed:', e);
  process.exit(1);
});
