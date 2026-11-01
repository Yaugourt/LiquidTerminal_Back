import { prismaContent } from '../../../core/prisma.content.service';
import { StorageService } from '../../../core/storage.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { HypurrProject, LtProject, SyncDiff, SyncField } from './hypurr-sync.types';
import { isPlaceholderDesc, isPlaceholderLogo, mapCategories, matchProjects, truncateDesc } from './hypurr.matcher';

/**
 * Database side of the Hypurr sync (content DB). Conservative by design:
 * - creates projects missing from LT (logo re-hosted to R2, falls back to the Hypurr URL)
 * - on existing projects, only fills fields that are still empty: every write is a
 *   conditional updateMany on the value read at diff time, so a value a human set in
 *   between is never overwritten
 * - never deletes a project, never removes a category
 * Idempotent: a second run finds the created projects matched and nothing left to fill.
 */

const LOGO_FOLDER = 'projects/logos';
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const PLACEHOLDER_LOGO = 'https://via.placeholder.com/150x150.png?text=No+Logo';
const AUTO_CATEGORY_DESC = 'Created automatically by the Hypurr Collective ecosystem sync';
const COL_MAX = 255;

export interface ApplyOptions {
  /** Safety cap on creations per run (a broken scrape must not flood the directory). */
  maxCreates: number;
  /** Re-host logos to R2 (default true); false keeps the Hypurr CDN URL. */
  rehostLogos: boolean;
  /** Compute the diff from the DB but write nothing. */
  dryRun?: boolean;
}

export interface ApplyResult {
  created: string[];
  createSkipped: { name: string; reason: string }[];
  filled: { title: string; fields: SyncField[] }[];
  categoriesCreated: string[];
  logosOnR2: number;
  logosFallback: number;
  failures: { name: string; error: string }[];
}

/** Current LT projects and category names, read from the content DB. */
export async function loadLtFromDb(): Promise<{ projects: LtProject[]; categoryNames: string[] }> {
  const [rows, cats] = await Promise.all([
    prismaContent.project.findMany({
      select: {
        id: true, title: true, desc: true, logo: true, token: true,
        twitter: true, telegram: true, discord: true, website: true,
        categories: { select: { category: { select: { name: true } } } },
      },
      orderBy: { id: 'asc' },
    }),
    prismaContent.category.findMany({ select: { name: true } }),
  ]);
  return {
    projects: rows.map((r) => ({
      id: r.id, title: r.title, desc: r.desc, logo: r.logo, token: r.token,
      twitter: r.twitter, telegram: r.telegram, discord: r.discord, website: r.website,
      categories: r.categories.map((c) => c.category.name),
    })),
    categoryNames: cats.map((c) => c.name),
  };
}

function fits(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && v.length <= COL_MAX ? v : null;
}

function extFromUrl(url: string, mime: string): string {
  const m = url.split('?')[0].match(/\.(avif|png|jpe?g|gif|webp|svg)$/i);
  if (m) return m[0].toLowerCase();
  const sub = mime.split('/')[1]?.split(/[+;]/)[0];
  return sub ? `.${sub.replace('jpeg', 'jpg')}` : '.png';
}

function getStorage(): StorageService | null {
  try {
    return StorageService.getInstance();
  } catch {
    return null;
  }
}

async function rehostLogo(url: string, slug: string, enabled: boolean): Promise<{ url: string; onR2: boolean }> {
  const storage = enabled ? getStorage() : null;
  if (!storage) return { url, onR2: false };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!mime.startsWith('image/')) throw new Error(`not an image (${mime || 'no content-type'})`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > LOGO_MAX_BYTES) throw new Error(`bad size ${body.length}`);
    const { url: r2Url } = await storage.uploadFile(body, LOGO_FOLDER, `${slug}${extFromUrl(url, mime)}`, mime);
    if (r2Url.length > COL_MAX) throw new Error('R2 URL longer than the column');
    return { url: r2Url, onR2: true };
  } catch (e) {
    logDeduplicator.warn('Hypurr sync: logo kept on the Hypurr CDN', {
      slug,
      error: e instanceof Error ? e.message : String(e),
    });
    return { url, onR2: false };
  }
}

async function getOrCreateCategoryId(name: string, createdNames: string[]): Promise<number | null> {
  const clean = name.trim().slice(0, 100);
  if (!clean) return null;
  const found = await prismaContent.category.findFirst({ where: { name: { equals: clean, mode: 'insensitive' } } });
  if (found) return found.id;
  try {
    const cat = await prismaContent.category.create({ data: { name: clean, description: AUTO_CATEGORY_DESC } });
    createdNames.push(cat.name);
    return cat.id;
  } catch {
    // Unique race: someone created it in between.
    const again = await prismaContent.category.findFirst({ where: { name: { equals: clean, mode: 'insensitive' } } });
    return again?.id ?? null;
  }
}

async function categoryIdsFor(h: HypurrProject, ltCategoryNames: string[], createdNames: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const c of mapCategories(h.categories, ltCategoryNames)) {
    const id = await getOrCreateCategoryId(c.name, createdNames);
    if (id != null) ids.push(id);
  }
  return [...new Set(ids)];
}

async function createProject(
  h: HypurrProject,
  ltCategoryNames: string[],
  opts: ApplyOptions,
  result: ApplyResult
): Promise<void> {
  const title = h.name.trim().slice(0, COL_MAX);
  const clash = await prismaContent.project.findFirst({
    where: { title: { equals: title, mode: 'insensitive' } },
    select: { id: true },
  });
  if (clash) {
    result.createSkipped.push({ name: h.name, reason: `title already used by project #${clash.id}` });
    return;
  }

  let logo = PLACEHOLDER_LOGO;
  if (h.logo) {
    const r = await rehostLogo(h.logo, h.slug, opts.rehostLogos);
    if (r.onR2) result.logosOnR2++;
    else result.logosFallback++;
    logo = fits(r.url) ?? PLACEHOLDER_LOGO;
  }

  const categoryIds = await categoryIdsFor(h, ltCategoryNames, result.categoriesCreated);
  await prismaContent.project.create({
    data: {
      title,
      desc: truncateDesc(h.description || title),
      logo,
      token: fits(h.ticker),
      twitter: fits(h.twitter),
      telegram: fits(h.telegram),
      discord: fits(h.discord),
      website: fits(h.website),
      categories: categoryIds.length > 0 ? { create: categoryIds.map((categoryId) => ({ categoryId })) } : undefined,
    },
  });
  result.created.push(title);
}

/** Fill the still-empty fields of one matched project. Returns the fields written. */
async function fillProject(
  h: HypurrProject,
  lt: LtProject,
  fields: SyncField[],
  ltCategoryNames: string[],
  opts: ApplyOptions,
  result: ApplyResult
): Promise<SyncField[]> {
  const written: SyncField[] = [];
  const emptyOr = (col: 'website' | 'twitter' | 'telegram' | 'discord' | 'token') => ({ OR: [{ [col]: null }, { [col]: '' }] });

  const simple: { field: SyncField; col: 'website' | 'twitter' | 'telegram' | 'discord' | 'token'; value: string | null }[] = [
    { field: 'website', col: 'website', value: fits(h.website) },
    { field: 'twitter', col: 'twitter', value: fits(h.twitter) },
    { field: 'telegram', col: 'telegram', value: fits(h.telegram) },
    { field: 'discord', col: 'discord', value: fits(h.discord) },
    { field: 'token', col: 'token', value: fits(h.ticker) },
  ];
  for (const s of simple) {
    if (!fields.includes(s.field) || !s.value) continue;
    const { count } = await prismaContent.project.updateMany({
      where: { id: lt.id, ...emptyOr(s.col) },
      data: { [s.col]: s.value },
    });
    if (count > 0) written.push(s.field);
  }

  if (fields.includes('description') && h.description && isPlaceholderDesc(lt.desc, lt.title)) {
    const { count } = await prismaContent.project.updateMany({
      where: { id: lt.id, desc: lt.desc },
      data: { desc: truncateDesc(h.description) },
    });
    if (count > 0) written.push('description');
  }

  if (fields.includes('logo') && h.logo && isPlaceholderLogo(lt.logo)) {
    const r = await rehostLogo(h.logo, h.slug, opts.rehostLogos);
    const url = fits(r.url);
    if (url) {
      const { count } = await prismaContent.project.updateMany({ where: { id: lt.id, logo: lt.logo }, data: { logo: url } });
      if (count > 0) {
        written.push('logo');
        if (r.onR2) result.logosOnR2++;
        else result.logosFallback++;
      }
    }
  }

  if (fields.includes('categories') && lt.categories.length === 0) {
    const current = await prismaContent.projectCategory.count({ where: { projectId: lt.id } });
    if (current === 0) {
      const ids = await categoryIdsFor(h, ltCategoryNames, result.categoriesCreated);
      if (ids.length > 0) {
        await prismaContent.projectCategory.createMany({
          data: ids.map((categoryId) => ({ projectId: lt.id, categoryId })),
          skipDuplicates: true,
        });
        written.push('categories');
      }
    }
  }

  return written;
}

function emptyResult(): ApplyResult {
  return { created: [], createSkipped: [], filled: [], categoriesCreated: [], logosOnR2: 0, logosFallback: 0, failures: [] };
}

/** Apply a diff computed against the DB (call loadLtFromDb + matchProjects first). */
export async function applySyncDiff(diff: SyncDiff, ltCategoryNames: string[], opts: ApplyOptions): Promise<ApplyResult> {
  const result = emptyResult();

  for (const [i, h] of diff.missing.entries()) {
    if (i >= opts.maxCreates) {
      result.createSkipped.push({ name: h.name, reason: `maxCreates (${opts.maxCreates}) reached` });
      continue;
    }
    try {
      await createProject(h, ltCategoryNames, opts, result);
    } catch (e) {
      result.failures.push({ name: h.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const m of diff.matched) {
    const fields = m.diffs.filter((d) => d.fillable).map((d) => d.field);
    if (fields.length === 0) continue;
    try {
      const written = await fillProject(m.hypurr, m.lt, fields, ltCategoryNames, opts, result);
      if (written.length > 0) result.filled.push({ title: m.lt.title, fields: written });
    } catch (e) {
      result.failures.push({ name: m.lt.title, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}

/** Full DB-backed run: read LT from the DB, diff, and apply. */
export async function runDbSync(
  hypurr: HypurrProject[],
  opts: ApplyOptions
): Promise<{ diff: SyncDiff; result: ApplyResult }> {
  const { projects, categoryNames } = await loadLtFromDb();
  const diff = matchProjects(hypurr, projects, categoryNames);
  const result = opts.dryRun ? emptyResult() : await applySyncDiff(diff, categoryNames, opts);
  return { diff, result };
}
