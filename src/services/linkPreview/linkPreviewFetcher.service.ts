import * as cheerio from 'cheerio';
import axios from 'axios';
import { ExtractedPreviewData } from '../../types/linkPreview.types';
import { LinkPreviewFetchError, LinkPreviewTimeoutError } from '../../errors/linkPreview.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { assertHostnameNotBlocked, SsrfBlockedError } from '../../utils/ssrf';

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
    if (
      code === 'ETIMEDOUT' ||
      code === 'ECONNABORTED' ||
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
  private async fetchOneHop(url: string): Promise<{ data: unknown; status: number }> {
    const urlObj = new URL(url);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      throw new LinkPreviewFetchError('Invalid protocol');
    }
    await assertHostnameNotBlocked(urlObj.hostname);

    return axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkPreviewBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: this.REQUEST_TIMEOUT,
      maxRedirects: 0,
      maxContentLength: this.MAX_CONTENT_LENGTH,
      // Accept 3xx as success so we can handle redirects ourselves.
      validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
    });
  }

  /**
   * Méthode avec retry pour les requêtes HTTP, avec follow manuel des redirects
   * et SSRF check à chaque hop.
   */
  private async fetchWithRetry(url: string): Promise<{ data: unknown; status: number }> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        logDeduplicator.info('Attempting to fetch preview', { url, attempt });

        let currentUrl = url;
        let response: Awaited<ReturnType<typeof this.fetchOneHop>> | null = null;
        for (let hop = 0; hop <= this.MAX_REDIRECTS; hop++) {
          response = await this.fetchOneHop(currentUrl);
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
          logDeduplicator.warn('Preview fetch blocked by SSRF guard', {
            url,
            reason: error.message,
          });
          throw new LinkPreviewFetchError(error.message);
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
      
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
          throw new LinkPreviewTimeoutError(`Timeout fetching preview for ${url}`);
        }
        if (error.response?.status) {
          throw new LinkPreviewFetchError(`HTTP ${error.response.status} error for ${url}`);
        }
      }
      
      throw new LinkPreviewFetchError(`Failed to fetch preview for ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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