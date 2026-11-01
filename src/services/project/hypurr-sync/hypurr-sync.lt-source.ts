import { LtProject } from './hypurr-sync.types';

/**
 * Read-only loader of the current LT projects through the public API, so a dry run
 * needs no database access. The list route caps `limit` at 100 (a larger value 500s).
 */

export const LT_PUBLIC_API = 'https://liquidterminal.up.railway.app';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

interface ApiProject {
  id: number;
  title: string;
  desc: string | null;
  logo: string | null;
  token: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  website: string | null;
  categories?: { name: string }[];
}

interface ApiPage<T> {
  data: T[];
  pagination?: { hasNext?: boolean; total?: number };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadLtProjectsFromApi(baseUrl: string = LT_PUBLIC_API): Promise<LtProject[]> {
  const out: LtProject[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await getJson<ApiPage<ApiProject>>(`${baseUrl}/project?limit=${PAGE_SIZE}&page=${page}`);
    for (const p of body.data ?? []) {
      out.push({
        id: p.id,
        title: p.title,
        desc: p.desc ?? '',
        logo: p.logo ?? '',
        token: p.token,
        twitter: p.twitter,
        telegram: p.telegram,
        discord: p.discord ?? null,
        website: p.website,
        categories: (p.categories ?? []).map((c) => c.name),
      });
    }
    if (!body.pagination?.hasNext || (body.data ?? []).length === 0) break;
  }
  return out;
}

export async function loadLtCategoryNamesFromApi(baseUrl: string = LT_PUBLIC_API): Promise<string[]> {
  const body = await getJson<ApiPage<{ name: string }>>(`${baseUrl}/category?limit=100`);
  return (body.data ?? []).map((c) => c.name);
}
