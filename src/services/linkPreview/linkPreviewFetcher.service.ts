import * as cheerio from 'cheerio';
import axios from 'axios';
import { ExtractedPreviewData } from '../../types/linkPreview.types';
import { LinkPreviewFetchError, LinkPreviewTimeoutError } from '../../errors/linkPreview.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class LinkPreviewFetcherService {
  private static instance: LinkPreviewFetcherService;
  private readonly REQUEST_TIMEOUT = 30000; // 30 secondes (augmenté de 10s à 30s)
  private readonly MAX_CONTENT_LENGTH = 1024 * 1024 * 2; // 2MB max
  private readonly MAX_RETRIES = 3; // 3 tentatives
  private readonly RETRY_DELAY = 2000; // 2 secondes entre chaque tentative

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
   * Méthode avec retry pour les requêtes HTTP
   */
  private async fetchWithRetry(url: string): Promise<any> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        logDeduplicator.info('Attempting to fetch preview', { url, attempt });
        
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LinkPreviewBot/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
          },
          timeout: this.REQUEST_TIMEOUT,
          maxRedirects: 5,
          maxContentLength: this.MAX_CONTENT_LENGTH,
        });
        
        logDeduplicator.info('Preview fetch successful', { url, attempt });
        return response;
        
      } catch (error) {
        lastError = error;
        logDeduplicator.warn('Preview fetch attempt failed', { url, attempt, error: error instanceof Error ? error.message : String(error) });
        
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

      const html = response.data;
      const $ = cheerio.load(html);

      // Extraire les données
      const title = this.getMetaContent($, [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
        'meta[name="title"]',
        'title'
      ]);

      const description = this.getMetaContent($, [
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
        'meta[name="description"]'
      ]);

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