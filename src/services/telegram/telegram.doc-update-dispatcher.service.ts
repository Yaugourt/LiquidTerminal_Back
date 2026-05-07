import { createHash } from 'crypto';
import { prisma } from '../../core/prisma.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import { formatDocUpdateTelegramMessage, type UpdatedPage } from '../../utils/telegram.doc-update';

const BASE_URL = 'https://hyperliquid.gitbook.io/hyperliquid-docs';
const SITEMAP_INDEX_URL = `${BASE_URL}/sitemap.xml`;
const RATE_LIMIT_DELAY_MS = 500;
const POLL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h
const INITIAL_DELAY_MS = 60_000; // 60s after start, let bot connect first

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Hyperliquid-Docs-Fetcher/1.0',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

const SPACE_ROOT_MD_OVERRIDES: Record<string, string> = {
  '/hyperliquid-docs': `${BASE_URL}/about-hyperliquid.md`,
  '/hyperliquid-docs/builder-tools': `${BASE_URL}/builder-tools/read-me-builder-tools.md`,
  '/hyperliquid-docs/support': `${BASE_URL}/support/read-me-support-guide.md`,
};

interface CachedTelegramUser {
  id: string;
  telegramId: string;
}

/**
 * Polls the Hyperliquid Gitbook sitemap every 3h, detects changed pages via SHA256,
 * and broadcasts a Telegram alert to every user via InternalWebSocketServer.
 */
export class TelegramDocUpdateDispatcherService {
  private static instance: TelegramDocUpdateDispatcherService;

  private isStopped = false;
  private initialDelayHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;

  private userCache: CachedTelegramUser[] = [];
  private cacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  private constructor() {}

  public static getInstance(): TelegramDocUpdateDispatcherService {
    if (!TelegramDocUpdateDispatcherService.instance) {
      TelegramDocUpdateDispatcherService.instance = new TelegramDocUpdateDispatcherService();
    }
    return TelegramDocUpdateDispatcherService.instance;
  }

  public start(): void {
    this.isStopped = false;

    this.initialDelayHandle = setTimeout(() => {
      void this.runPoll();
      this.intervalHandle = setInterval(() => {
        void this.runPoll();
      }, POLL_INTERVAL_MS);
    }, INITIAL_DELAY_MS);

    logDeduplicator.info('TelegramDocUpdateDispatcherService: Started — first poll in 60s, then every 3h');
  }

  public stop(): void {
    this.isStopped = true;
    if (this.initialDelayHandle) {
      clearTimeout(this.initialDelayHandle);
      this.initialDelayHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.userCache = [];
    this.cacheLoadedAt = 0;
    logDeduplicator.info('TelegramDocUpdateDispatcherService: Stopped');
  }

  private async runPoll(): Promise<void> {
    if (this.isStopped) return;
    logDeduplicator.info('TelegramDocUpdateDispatcherService: Poll cycle starting');

    let urls: string[];
    try {
      urls = await fetchSitemapUrls();
    } catch (error) {
      logDeduplicator.error('TelegramDocUpdateDispatcherService: Failed to fetch sitemap', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const existingPages = await prisma.hyperliquidDocPage.findMany({
      select: { pageUrl: true, contentHash: true, content: true },
    });
    const pageMap = new Map(existingPages.map(p => [p.pageUrl, { hash: p.contentHash, content: p.content }]));

    const updatedPages: UpdatedPage[] = [];

    for (const url of urls) {
      if (this.isStopped) {
        logDeduplicator.info('TelegramDocUpdateDispatcherService: Poll interrupted by stop()');
        return;
      }

      await sleep(RATE_LIMIT_DELAY_MS);
      if (this.isStopped) return;

      const relPath = urlToRelPath(url);
      let newContent: string;

      try {
        newContent = await fetchPageMarkdown(url);
      } catch (error) {
        logDeduplicator.warn('TelegramDocUpdateDispatcherService: Failed to fetch page, skipping', {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const newHash = computeHash(newContent);
      const existing = pageMap.get(url);

      await prisma.hyperliquidDocPage.upsert({
        where: { pageUrl: url },
        create: { pageUrl: url, relPath, contentHash: newHash, content: newContent },
        update: { relPath, contentHash: newHash, content: newContent },
      });

      if (existing !== undefined && existing.hash !== newHash) {
        updatedPages.push({ relPath, pageUrl: url, oldContent: existing.content, newContent });
        logDeduplicator.info('TelegramDocUpdateDispatcherService: Page changed', { url, relPath });
      }
    }

    logDeduplicator.info('TelegramDocUpdateDispatcherService: Poll cycle complete', {
      total: urls.length,
      changed: updatedPages.length,
    });

    if (updatedPages.length === 0) return;

    await this.broadcastToAllUsers(updatedPages);

    await prisma.hyperliquidDocPage.updateMany({
      where: { pageUrl: { in: updatedPages.map(p => p.pageUrl) } },
      data: { lastBroadcastAt: new Date() },
    });
  }

  private async broadcastToAllUsers(pages: UpdatedPage[]): Promise<void> {
    await this.ensureUserCacheFresh();
    if (this.userCache.length === 0) return;

    const message = formatDocUpdateTelegramMessage(pages);
    const wsServer = InternalWebSocketServer.getInstance();
    let dispatched = 0;

    for (const user of this.userCache) {
      if (this.isStopped) return;

      const sent = wsServer.broadcastDocUpdateAlert(user.telegramId, message);
      if (sent > 0) dispatched++;
    }

    logDeduplicator.info('TelegramDocUpdateDispatcherService: Broadcast complete', {
      pageCount: pages.length,
      userCount: this.userCache.length,
      dispatched,
    });
  }

  private async ensureUserCacheFresh(): Promise<void> {
    if (Date.now() - this.cacheLoadedAt < TelegramDocUpdateDispatcherService.CACHE_TTL_MS) return;

    try {
      const users = await prisma.telegramUser.findMany({
        where: { docAlertsEnabled: true },
        select: { id: true, telegramId: true },
      });
      this.userCache = users.map(u => ({
        id: u.id,
        telegramId: u.telegramId.toString(),
      }));
      this.cacheLoadedAt = Date.now();
      logDeduplicator.debug('TelegramDocUpdateDispatcherService: User cache refreshed', {
        count: this.userCache.length,
      });
    } catch (error) {
      logDeduplicator.error('TelegramDocUpdateDispatcherService: Failed to refresh user cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ── Gitbook fetching helpers ─────────────────────────────────────────────────

async function fetchSitemapUrls(sitemapUrl = SITEMAP_INDEX_URL): Promise<string[]> {
  const res = await fetch(sitemapUrl, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status} ${sitemapUrl}`);
  const xml = await res.text();

  const subSitemaps = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  if (subSitemaps.length > 0) {
    const all: string[] = [];
    for (const sub of subSitemaps) {
      all.push(...(await fetchSitemapUrls(sub)));
    }
    return all;
  }

  const urls = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  if (urls.length > 0) return urls;

  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
}

async function fetchPageMarkdown(url: string): Promise<string> {
  const path = new URL(url).pathname.replace(/\/$/, '');
  const mdUrl = SPACE_ROOT_MD_OVERRIDES[path] ?? url.replace(/\/$/, '') + '.md';
  return fetchWithRetry(async () => {
    const res = await fetch(mdUrl, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch markdown: ${res.status} ${mdUrl}`);
    return res.text();
  });
}

async function fetchWithRetry(fn: () => Promise<string>, maxRetries = 3): Promise<string> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries - 1) await sleep(2000 * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function urlToRelPath(url: string): string {
  const path = new URL(url).pathname.replace(/\/$/, '');
  const prefix = '/hyperliquid-docs';
  if (path === prefix) return 'README';
  if (path.startsWith(prefix + '/')) return path.slice(prefix.length + 1);
  return path.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
