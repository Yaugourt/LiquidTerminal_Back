import * as cheerio from 'cheerio';
import axios from 'axios';
import { promisify } from 'util';
import { constants, gunzip } from 'zlib';
import { ExtractedPreviewData } from '../../types/linkPreview.types';
import { LinkPreviewFetchError, LinkPreviewTimeoutError } from '../../errors/linkPreview.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { resolveSafeAddress, SsrfBlockedError } from '../../utils/ssrf';

const gunzipAsync = promisify(gunzip);

/**
 * Bounded concurrency for outbound preview fetches. The batch endpoint is
 * public and each request can trigger up to 10 fetches of 2 MB each, all via
 * axios directly (outside the shared outbound pool). Without a cap, a burst
 * turns into hundreds of concurrent sockets + cheerio parses — an availability
 * vector independent of the per-IP limiter. This ceiling bounds the whole
 * process's link-preview outbound work regardless of how many callers arrive.
 */
const MAX_CONCURRENT_PREVIEW_FETCHES = 6;
/**
 * The wait line is bounded too. Without it a handful of requests to slow or
 * redirecting hosts keep every slot busy while an unbounded line of waiters
 * piles up behind them, starving the other user of the slots (educational
 * resource creation). Past either limit a fetch fails at once as "preview
 * unavailable" and the batch route still answers with the other previews.
 */
const MAX_QUEUED_PREVIEW_FETCHES = 50;
const MAX_QUEUE_WAIT_MS = 15_000;
/** Wall-clock ceiling for one URL once it holds a slot: every attempt and redirect hop included. */
const PREVIEW_TOTAL_DEADLINE_MS = 20_000;

let activePreviewFetches = 0;
interface PreviewWaiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}
const previewFetchQueue: PreviewWaiter[] = [];

async function acquirePreviewSlot(): Promise<void> {
  if (activePreviewFetches < MAX_CONCURRENT_PREVIEW_FETCHES) {
    activePreviewFetches += 1;
    return;
  }
  if (previewFetchQueue.length >= MAX_QUEUED_PREVIEW_FETCHES) {
    throw new LinkPreviewFetchError('Preview temporarily unavailable');
  }
  // The slot is handed over by releasePreviewSlot() without being freed, so a
  // newcomer can never slip in between the release and the waiter waking up.
  await new Promise<void>((resolve, reject) => {
    const waiter: PreviewWaiter = {
      grant: () => {
        clearTimeout(waiter.timer);
        resolve();
      },
      timer: setTimeout(() => {
        const i = previewFetchQueue.indexOf(waiter);
        if (i >= 0) previewFetchQueue.splice(i, 1);
        reject(new LinkPreviewTimeoutError('Preview temporarily unavailable'));
      }, MAX_QUEUE_WAIT_MS),
    };
    previewFetchQueue.push(waiter);
  });
}

function releasePreviewSlot(): void {
  const next = previewFetchQueue.shift();
  if (next) {
    next.grant();
    return;
  }
  activePreviewFetches = Math.max(0, activePreviewFetches - 1);
}

export class LinkPreviewFetcherService {
  private static instance: LinkPreviewFetcherService;
  private readonly REQUEST_TIMEOUT = 8000; // 8s — long enough for slow blogs, short enough to bound attacker amplification
  private readonly MAX_CONTENT_LENGTH = 1024 * 1024 * 2; // 2MB max
  private readonly MAX_RETRIES = 3; // 3 tentatives
  private readonly RETRY_DELAY = 2000; // 2 secondes entre chaque tentative
  private readonly MAX_REDIRECTS = 5;

  private constructor() {}

  public static getInstance(): LinkPreviewFetcherService {
    if (!LinkPreviewFetcherService.instance) {
      LinkPreviewFetcherService.instance = new LinkPreviewFetcherService();
    }
    return LinkPreviewFetcherService.instance;
  }

  /**
   * Méthode helper pour attendre
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Erreurs réseau/DNS permanentes : inutile de retenter 3× (même résultat, logs bruyants).
   */
  private isRetryablePreviewError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }
    if (error.response) {
      const status = error.response.status;
      if (status === 429) return true;
      if (status >= 500 && status < 600) return true;
      return false;
    }
    const code = error.code;
    if (
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'ECONNREFUSED'
    ) {
      return false;
    }
    // A timeout is not retried: a host that is too slow once will hold a slot
    // for another 8 s per attempt. The overall deadline cancels (ERR_CANCELED).
    if (
      code === 'ETIMEDOUT' ||
      code === 'ECONNABORTED' ||
      code === 'ERR_CANCELED'
    ) {
      return false;
    }
    if (
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'EAI_AGAIN'
    ) {
      return true;
    }
    return true;
  }

  /**
   * Single HTTP hop with SSRF check on the target hostname.
   * Redirects are handled manually (maxRedirects: 0) so we can re-validate the
   * destination hostname at every hop — auto-follow would let a server redirect
   * us to a private/metadata address after the first DNS check.
   */
  private async fetchOneHop(url: string, deadline: number): Promise<{ data: unknown; status: number }> {
    const urlObj = new URL(url);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      throw new LinkPreviewFetchError('Invalid protocol');
    }

    // Port allowlist: only the standard web ports. Even on a public-looking IP,
    // an odd port is almost always an attempt to reach an internal service
    // (DB, redis, admin panel) rather than a web page.
    const port = urlObj.port ? Number(urlObj.port) : urlObj.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) {
      throw new SsrfBlockedError('Refused to connect to a non-standard port');
    }

    // Resolve + vet the hostname, then PIN the vetted IP into the connection.
    // axios re-resolves by default; passing `lookup` forces it to dial exactly
    // this address, closing the DNS-rebinding TOCTOU. TLS SNI / cert validation
    // still use the original hostname from `url`, so HTTPS stays correct.
    const safe = await resolveSafeAddress(urlObj.hostname);

    // Whatever is left of this URL's overall budget caps the hop. axios'
    // `timeout` only covers socket inactivity, so a host dripping bytes would
    // outlive it: the abort signal is the hard stop.
    const budget = deadline - Date.now();
    if (budget <= 0) {
      throw new LinkPreviewTimeoutError('Timeout fetching preview');
    }

    const response = await axios.get<Buffer>(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkPreviewBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip',
      },
      timeout: Math.min(this.REQUEST_TIMEOUT, budget),
      signal: AbortSignal.timeout(budget),
      maxRedirects: 0,
      maxContentLength: this.MAX_CONTENT_LENGTH,
      // The remote host picks the Content-Encoding, whatever we asked for, and
      // axios would decode any of them, Brotli included (Node CVE-2026-111497).
      // Take the raw bytes and decode them in decodeBody().
      decompress: false,
      responseType: 'arraybuffer',
      // Accept 3xx as success so we can handle redirects ourselves.
      validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      lookup: (async () => [safe.address, safe.family] as [string, number]),
    });

    // A redirect's body is never read.
    if (response.status >= 300) {
      return response;
    }
    return {
      ...response,
      data: await this.decodeBody(response.data, response.headers?.['content-encoding']),
    };
  }

  /**
   * Identity or gzip only (the one encoding we ask for). The inflated size is
   * capped like the raw body, so a hostile host can neither reach another
   * decoder nor send a decompression bomb.
   */
  private async decodeBody(raw: Buffer, contentEncoding: unknown): Promise<string> {
    const encoding = String(contentEncoding ?? '').trim().toLowerCase();
    if (encoding === '' || encoding === 'identity') {
      return raw.toString('utf8');
    }
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      // SYNC_FLUSH like axios' own decoder: a truncated or empty gzip body
      // still reads instead of failing the preview.
      const inflated = await gunzipAsync(raw, {
        maxOutputLength: this.MAX_CONTENT_LENGTH,
        finishFlush: constants.Z_SYNC_FLUSH,
      });
      return inflated.toString('utf8');
    }
    throw new LinkPreviewFetchError(`Unsupported content encoding: ${encoding}`);
  }

  /**
   * Méthode avec retry pour les requêtes HTTP, avec follow manuel des redirects
   * et SSRF check à chaque hop.
   */
  private async fetchWithRetry(url: string): Promise<{ data: unknown; status: number }> {
    let lastError: unknown;
    const deadline = Date.now() + PREVIEW_TOTAL_DEADLINE_MS;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        logDeduplicator.info('Attempting to fetch preview', { url, attempt });

        let currentUrl = url;
        let response: Awaited<ReturnType<typeof this.fetchOneHop>> | null = null;
        for (let hop = 0; hop <= this.MAX_REDIRECTS; hop++) {
          response = await this.fetchOneHop(currentUrl, deadline);
          if (response.status < 300) break;
          const locationHeader =
            (response as unknown as { headers?: Record<string, string | undefined> }).headers
              ?.location;
          if (!locationHeader) {
            throw new LinkPreviewFetchError(
              `HTTP ${response.status} without Location header for ${currentUrl}`,
            );
          }
          // Resolve relative redirects against the current URL.
          currentUrl = new URL(locationHeader, currentUrl).toString();
          if (hop === this.MAX_REDIRECTS) {
            throw new LinkPreviewFetchError(`Too many redirects starting at ${url}`);
          }
        }
        if (!response) {
          throw new LinkPreviewFetchError(`No response for ${url}`);
        }

        logDeduplicator.info('Preview fetch successful', { url, attempt });
        return response;
      } catch (error) {
        lastError = error;
        // SSRF blocks are permanent — never retry them.
        if (error instanceof SsrfBlockedError) {
          // The reason (which resolved address was blocked) is kept in our logs
          // only — never relayed to the caller, or the endpoint becomes an
          // internal port/host scanner.
          logDeduplicator.warn('Preview fetch blocked by SSRF guard', {
            url,
            reason: error.message,
          });
          throw new LinkPreviewFetchError('This URL is not allowed');
        }
        if (error instanceof LinkPreviewTimeoutError || Date.now() >= deadline) {
          logDeduplicator.warn('Preview fetch hit its overall deadline', { url, attempt });
          throw error instanceof LinkPreviewTimeoutError
            ? error
            : new LinkPreviewTimeoutError(`Timeout fetching preview for ${url}`);
        }
        logDeduplicator.warn('Preview fetch attempt failed', {
          url,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        if (!this.isRetryablePreviewError(error)) {
          throw lastError;
        }
        if (attempt < this.MAX_RETRIES) {
          // No point retrying when the deadline would hit during the wait.
          if (deadline - Date.now() <= this.RETRY_DELAY) {
            throw lastError;
          }
          await this.delay(this.RETRY_DELAY);
        }
      }
    }

    throw lastError;
  }

  /**
   * Récupère les données d'aperçu d'une URL
   */
  async fetchPreviewData(url: string): Promise<ExtractedPreviewData> {
    await acquirePreviewSlot();
    try {
      // Valider l'URL
      const urlObj = new URL(url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new LinkPreviewFetchError('Invalid protocol');
      }

      // Faire la requête HTTP avec retry
      const response = await this.fetchWithRetry(url);

      const html =
        typeof response.data === 'string'
          ? response.data
          : Buffer.isBuffer(response.data)
            ? response.data.toString('utf8')
            : String(response.data);
      const $ = cheerio.load(html);

      // Extraire les données
      let title = this.getMetaContent($, [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
        'meta[name="title"]',
        'title'
      ]);

      let description = this.getMetaContent($, [
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
        'meta[name="description"]'
      ]);

      // Twitter/X met l'auteur (`<Name> (@<handle>) on X`) dans og:title et le
      // texte effectif du tweet dans og:description, à l'envers de la convention.
      // On swap pour que le card affiche le contenu du tweet en titre.
      const isTwitter =
        urlObj.hostname === 'x.com' ||
        urlObj.hostname === 'twitter.com' ||
        urlObj.hostname.endsWith('.x.com') ||
        urlObj.hostname.endsWith('.twitter.com');
      if (isTwitter && title && description) {
        const tweetText = description;
        description = title;
        title = tweetText;
      }

      let image = this.getMetaContent($, [
        'meta[property="og:image"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]'
      ]);

      // Convertir URL relative en absolue
      if (image && !image.startsWith('http')) {
        try {
          image = new URL(image, url).href;
        } catch {
          image = null;
        }
      }

      const siteName = this.getMetaContent($, [
        'meta[property="og:site_name"]'
      ]) || urlObj.hostname;

      // Extraire favicon
      let favicon = this.getMetaContent($, [
        'link[rel="icon"][href]',
        'link[rel="shortcut icon"][href]'
      ]);

      if (favicon && !favicon.startsWith('http')) {
        try {
          favicon = new URL(favicon, url).href;
        } catch {
          favicon = `${urlObj.protocol}//${urlObj.hostname}/favicon.ico`;
        }
      } else if (!favicon) {
        favicon = `${urlObj.protocol}//${urlObj.hostname}/favicon.ico`;
      }

      return {
        title: title ? title.substring(0, 255) : null,
        description: description ? description.substring(0, 500) : null,
        image,
        siteName: siteName ? siteName.substring(0, 100) : null,
        favicon
      };

    } catch (error: unknown) {
      // Aperçu best-effort : DNS down / 404 / timeout sont des cas d’exploitation courants, pas des incidents serveur
      logDeduplicator.warn('Preview fetch failed (URL unreachable or bad response)', { url, error: error instanceof Error ? error.message : String(error) });

      if (error instanceof LinkPreviewTimeoutError) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
          throw new LinkPreviewTimeoutError(`Timeout fetching preview for ${url}`);
        }
        if (error.response?.status) {
          throw new LinkPreviewFetchError(`HTTP ${error.response.status} error for ${url}`);
        }
      }
      
      // Generic on purpose: the raw axios error can carry the dialed IP/port
      // (e.g. "ECONNREFUSED …:5432"), which must not reach the caller.
      throw new LinkPreviewFetchError('Failed to fetch preview');
    } finally {
      releasePreviewSlot();
    }
  }

  /**
   * Fonction helper pour extraire le contenu des métadonnées
   */
  private getMetaContent($: cheerio.CheerioAPI, selectors: string[]): string | null {
    for (const selector of selectors) {
      const element = $(selector);
      const content = element.attr('content') || element.text();
      if (content && content.trim()) {
        return content.trim();
      }
    }
    return null;
  }
} 