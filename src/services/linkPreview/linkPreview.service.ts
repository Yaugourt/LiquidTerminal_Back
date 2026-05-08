import { 
  LinkPreviewResponse, 
  LinkPreviewCreateInput, 
  LinkPreviewUpdateInput,
  LinkPreviewQueryParams,
  ExtractedPreviewData
} from '../../types/linkPreview.types';
import { 
  LinkPreviewNotFoundError, 
  LinkPreviewAlreadyExistsError,
  LinkPreviewValidationError,
  LinkPreviewFetchError,
  LinkPreviewTimeoutError
} from '../../errors/linkPreview.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { CACHE_PREFIX, CACHE_TTL } from '../../constants/cache.constants';
import { 
  linkPreviewCreateSchema, 
  linkPreviewUpdateSchema, 
  linkPreviewQuerySchema 
} from '../../schemas/linkPreview.schema';
import { linkPreviewRepository } from '../../repositories';
import { BaseService } from '../../core/crudBase.service';
import { cacheService } from '../../core/cache.service';
import { LinkPreviewFetcherService } from './linkPreviewFetcher.service';

export class LinkPreviewService extends BaseService<
  LinkPreviewResponse, 
  LinkPreviewCreateInput, 
  LinkPreviewUpdateInput, 
  LinkPreviewQueryParams
> {
  private static instance: LinkPreviewService;
  protected repository = linkPreviewRepository;
  protected cacheKeyPrefix = CACHE_PREFIX.LINK_PREVIEW;
  protected validationSchemas = {
    create: linkPreviewCreateSchema,
    update: linkPreviewUpdateSchema,
    query: linkPreviewQuerySchema
  };
  protected errorClasses = {
    notFound: LinkPreviewNotFoundError,
    alreadyExists: LinkPreviewAlreadyExistsError,
    validation: LinkPreviewValidationError
  };

  private linkPreviewFetcher: LinkPreviewFetcherService;

  private constructor() {
    super();
    this.linkPreviewFetcher = LinkPreviewFetcherService.getInstance();
  }

  public static getInstance(): LinkPreviewService {
    if (!LinkPreviewService.instance) {
      LinkPreviewService.instance = new LinkPreviewService();
    }
    return LinkPreviewService.instance;
  }

  /**
   * Génère un aperçu pour une URL donnée
   * Vérifie d'abord le cache, puis la base de données, puis génère un nouvel aperçu
   */
  async generatePreview(url: string): Promise<LinkPreviewResponse> {
    try {
      // 1. Vérifier le cache Redis et la base de données
      const cacheKey = `preview:${Buffer.from(url).toString('base64')}`;
      const cached = await cacheService.getOrSet(cacheKey, async () => {
        const existingPreview = await this.repository.findByUrl(url);
        if (existingPreview && this.isRecentPreview(existingPreview.updatedAt)) {
          logDeduplicator.info('Link preview found in database', { url });
          return existingPreview;
        }
        return null;
      }, CACHE_TTL.LONG);
      
      if (cached) {
        logDeduplicator.info('Link preview found in cache', { url });
        return cached;
      }

      // 3. Générer nouveau preview
      logDeduplicator.info('Generating new link preview', { url });
      const previewData = await this.linkPreviewFetcher.fetchPreviewData(url);
      
      // 4. Sauvegarder en base
      const savedPreview = await this.repository.upsert(url, {
        url,
        title: previewData.title || undefined,
        description: previewData.description || undefined,
        image: previewData.image || undefined,
        siteName: previewData.siteName || undefined,
        favicon: previewData.favicon || undefined
      });

      // 5. Mettre en cache Redis (déjà fait par getOrSet)
      await cacheService.getOrSet(cacheKey, async () => savedPreview, CACHE_TTL.LONG);

      logDeduplicator.info('Link preview generated successfully', { url, id: savedPreview.id });
      return savedPreview;

    } catch (error) {
      logDeduplicator.warn('Link preview not generated (fetch or parse failed)', { url, error: error instanceof Error ? error.message : String(error) });
      
      if (error instanceof LinkPreviewFetchError || error instanceof LinkPreviewTimeoutError) {
        throw error;
      }
      
      throw new LinkPreviewFetchError(`Failed to generate preview for ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Génère des aperçus pour plusieurs URLs en batch
   */
  async generatePreviewsBatch(urls: string[]): Promise<Array<{
    url: string;
    success: boolean;
    data: LinkPreviewResponse | null;
    error: string | null;
  }>> {
    const results = await Promise.allSettled(
      urls.map(url => this.generatePreview(url))
    );

    return results.map((result, index) => ({
      url: urls[index],
      success: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : null
    }));
  }

  /**
   * Vérifie si un aperçu est récent (moins de 24h)
   */
  private isRecentPreview(updatedAt: Date, hours: number = 24): boolean {
    const now = new Date();
    const diffHours = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);
    return diffHours < hours;
  }

  /**
   * Regénère les aperçus expirés (pour tâche cron)
   */
  async refreshExpiredPreviews(): Promise<void> {
    try {
      const expiredDate = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)); // 7 jours
      
      const expiredPreviews = await this.repository.findExpiredPreviews(expiredDate, 50);

      logDeduplicator.info('Starting refresh of expired previews', { count: expiredPreviews.length });

      for (const preview of expiredPreviews) {
        try {
          await this.generatePreview(preview.url);
          // Petit délai pour éviter rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logDeduplicator.error('Error refreshing preview', { url: preview.url, error: error instanceof Error ? error.message : String(error) });
        }
      }

      logDeduplicator.info('Finished refreshing expired previews', { count: expiredPreviews.length });
    } catch (error) {
      logDeduplicator.error('Error refreshing expired previews', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Surcharge de la méthode checkExists pour les aperçus de liens
   */
  protected async checkExists(data: LinkPreviewCreateInput): Promise<boolean> {
    return await this.repository.existsByUrl(data.url);
  }

  /**
   * Surcharge de la méthode checkExistsForUpdate pour les aperçus de liens
   */
  protected async checkExistsForUpdate(id: number, data: LinkPreviewUpdateInput): Promise<boolean> {
    // Pour les aperçus, on ne vérifie pas les doublons lors de la mise à jour
    return false;
  }

  /**
   * Surcharge de la méthode checkCanDelete pour les aperçus de liens
   */
  protected async checkCanDelete(id: number): Promise<void> {
    // Vérifier si l'aperçu est utilisé par des ressources éducatives
    const preview = await this.repository.findById(id.toString());
    if (preview) {
      // TODO: Ajouter la vérification des ressources liées quand la relation sera implémentée
      // Pour l'instant, on permet la suppression
    }
  }

  /**
   * Vérifie si une LinkPreview est utilisée par d'autres ressources
   */
  async isUsedByOtherResources(linkPreviewId: string, excludeResourceId?: number): Promise<boolean> {
    try {
      const { prismaContent } = await import('../../core/prisma.content.service');
      
      const whereClause: any = {
        linkPreviewId: linkPreviewId
      };
      
      if (excludeResourceId) {
        whereClause.id = { not: excludeResourceId };
      }
      
      const count = await prismaContent.educationalResource.count({
        where: whereClause
      });
      
      return count > 0;
    } catch (error) {
      logDeduplicator.error('Error checking if link preview is used by other resources', {
        linkPreviewId,
        excludeResourceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false; // En cas d'erreur, on considère qu'elle est utilisée pour éviter la suppression
    }
  }

  /**
   * Supprime une LinkPreview par son ID string
   */
  async deleteById(id: string): Promise<void> {
    await this.repository.delete(id);
  }

  /**
   * Récupère une LinkPreview par son ID string
   */
  async getByIdString(id: string): Promise<LinkPreviewResponse | null> {
    return await this.repository.findById(id);
  }
} 