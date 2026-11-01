/**
 * Re-titles the wiki's link previews from their source, so no card shows a wrong title.
 *
 * - X posts: headline + author from the post itself (api.fxtwitter.com, public JSON),
 *   stored as the fetcher now stores them (title = headline, description = "Name (@handle) on X").
 *   X articles keep their article title.
 * - YouTube and Spotify: the real title from their oEmbed endpoint (some imported titles
 *   were rewritten summaries, not the video's title).
 * - Anything else with an empty title: og:title of the page.
 * A source that cannot be read leaves the row untouched; it is listed, never guessed.
 *
 * Dry run by default. Usage:
 *   npx tsx scripts/fix-wiki-preview-titles.ts                 # print the planned changes
 *   npx tsx scripts/fix-wiki-preview-titles.ts --apply         # write them
 * --apply first writes the current values of every touched row to
 * fix-wiki-preview-titles.backup-<timestamp>.json, so the change can be undone.
 */
import 'dotenv/config';
import fs from 'fs';
import * as cheerio from 'cheerio';
import { prismaContent } from '../src/core/prisma.content.service';
import { isXHost, xHeadline } from '../src/services/linkPreview/xTitle';

const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (compatible; LiquidTerminalWiki/1.0; +https://liquidterminal.xyz)';

interface Row {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
}
interface Change {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  source: string;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

interface FxTweet {
  code: number;
  tweet?: { text?: string; author: { name: string; screen_name: string }; article?: { title?: string } | null };
}

async function fromX(url: string): Promise<Omit<Change, 'id' | 'url'> | null> {
  const id = url.match(/\/status(?:es)?\/(\d+)/)?.[1];
  if (!id) return null; // Spaces and profiles: nothing public to read the title from.
  const fx = await getJson<FxTweet>(`https://api.fxtwitter.com/status/${id}`);
  const tweet = fx?.code === 200 ? fx.tweet : undefined;
  if (!tweet) return null;
  const title = tweet.article?.title?.trim() || xHeadline(tweet.text);
  if (!title) return null;
  return {
    title,
    description: `${tweet.author.name} (@${tweet.author.screen_name}) on X`,
    source: tweet.article?.title ? 'x article' : 'x post',
  };
}

async function fromOembed(url: string): Promise<Omit<Change, 'id' | 'url'> | null> {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const endpoint = /(^|\.)youtube\.com$|^youtu\.be$/.test(host)
    ? 'https://www.youtube.com/oembed?format=json&url='
    : host === 'open.spotify.com'
      ? 'https://open.spotify.com/oembed?url='
      : null;
  if (!endpoint) return null;
  const o = await getJson<{ title?: string; author_name?: string }>(endpoint + encodeURIComponent(url));
  if (!o?.title) return null;
  return { title: o.title.trim(), description: o.author_name?.trim() || null, source: 'oembed' };
}

async function fromOgTitle(url: string): Promise<Omit<Change, 'id' | 'url'> | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text()).trim();
    return title ? { title, description: null, source: 'og:title' } : null;
  } catch {
    return null;
  }
}

function clip(s: string | null, n: number): string | null {
  return s && s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function main(): Promise<void> {
  const rows = await prismaContent.linkPreview.findMany({
    where: { resources: { some: {} } },
    select: { id: true, url: true, title: true, description: true },
  });
  console.log(`${rows.length} previews attached to wiki resources`);

  const changes: Change[] = [];
  const unreadable: Row[] = [];
  let i = 0;
  for (const row of rows) {
    i++;
    let host: string;
    try {
      host = new URL(row.url).hostname;
    } catch {
      continue;
    }
    const found = isXHost(host)
      ? await fromX(row.url)
      : (await fromOembed(row.url)) ?? (!row.title?.trim() ? await fromOgTitle(row.url) : null);
    if (!found) {
      if (isXHost(host) || !row.title?.trim()) unreadable.push(row);
      continue;
    }
    const title = clip(found.title, 255);
    // Keep an existing description unless the source gives one (oEmbed author, X author line).
    const description = clip(found.description ?? row.description, 500);
    if (title !== row.title || description !== row.description) {
      changes.push({ id: row.id, url: row.url, title, description, source: found.source });
    }
    if (i % 50 === 0) console.log(`  ${i}/${rows.length} read`);
  }

  for (const c of changes) {
    const old = rows.find((r) => r.id === c.id)!;
    console.log(`\n[${c.source}] ${c.url}\n  - ${JSON.stringify(old.title)}\n  + ${JSON.stringify(c.title)}`);
    if (c.description !== old.description) {
      console.log(`  desc ${JSON.stringify(old.description)} -> ${JSON.stringify(c.description)}`);
    }
  }
  console.log(`\nUnreadable (left as is): ${unreadable.length}`);
  for (const r of unreadable) console.log(`  ${r.url}  ${JSON.stringify(r.title?.slice(0, 80))}`);
  console.log(`\n${changes.length} previews to update${APPLY ? '' : ' (dry run, pass --apply to write)'}`);

  if (!APPLY || changes.length === 0) return;
  const backup = `fix-wiki-preview-titles.backup-${Date.now()}.json`;
  fs.writeFileSync(
    backup,
    JSON.stringify(rows.filter((r) => changes.some((c) => c.id === r.id)), null, 1),
  );
  console.log(`backup of the current values: ${backup}`);
  for (const c of changes) {
    await prismaContent.linkPreview.update({
      where: { id: c.id },
      data: { title: c.title, description: c.description },
    });
  }
  console.log(`${changes.length} previews updated`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prismaContent.$disconnect());
