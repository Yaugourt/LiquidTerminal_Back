import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.service';
import { cacheService } from './cache.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { CACHE_TTL } from '../constants/cache.constants';

/**
 * Type for Prisma transaction clients (PrismaClient without connection/transaction methods)
 */
type PrismaTransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Minimal structural type for any Prisma client (Core / Content / Telegram / Historical).
 * BaseService.create/update/delete open a $transaction on this client. Subclasses backed
 * by a non-Core DB must override `transactionClient` with their dedicated PrismaClient
 * (e.g. prismaContent), otherwise the TX opens on Core while the repository writes to
 * the other DB → FK violations and orphan rows. See refactor/db-split-core-content-telegram.
 */
export interface AnyPrismaClient {
  $transaction<R>(fn: (tx: unknown) => Promise<R>, opts?: { timeout?: number }): Promise<R>;
}

/**
 * Interface pour les paramètres de requête de base.
 * Subtypes can add additional properties via structural typing (extends).
 */
export interface BaseQueryParams {
  page?: number;
  limit?: number;
}

/**
 * Interface minimale que tous les repositories doivent satisfaire.
 * Garantit le support des transactions Prisma.
 */
export interface BaseServiceRepository {
  setPrismaClient(client: PrismaTransactionClient): void;
  resetPrismaClient(): void;
}

/**
 * Contrat CRUD complet pour les repositories utilisés par les méthodes par défaut de BaseService.
 * Les repositories qui ne satisfont pas ce contrat doivent avoir leurs services
 * qui surchargent les méthodes correspondantes de BaseService.
 */
export interface CrudRepository<T, CreateInput, UpdateInput, QueryParams> extends BaseServiceRepository {
  findAll(query: QueryParams): Promise<{ data: T[]; pagination: { total: number } }>;
  findById(id: number | string): Promise<T | null>;
  create(data: CreateInput): Promise<T>;
  update(id: number | string, data: UpdateInput): Promise<T>;
  delete(id: number | string): Promise<void>;
}

/**
 * Classe de base abstraite pour les services
 * Encapsule les fonctionnalités communes à tous les services
 */
export abstract class BaseService<T, CreateInput, UpdateInput, QueryParams extends BaseQueryParams> {
  /**
   * Repository utilisé par le service.
   * Les méthodes CRUD par défaut castent vers CrudRepository<T, ...> en interne.
   * Les services dont le repository ne satisfait pas CrudRepository doivent surcharger ces méthodes.
   */
  protected abstract repository: BaseServiceRepository;

  /**
   * Client Prisma utilisé par les méthodes create/update/delete pour ouvrir une `$transaction`.
   * Défaut : `prisma` (Core). Les services Content / Telegram doivent override ce champ
   * avec leur client respectif (`prismaContent`, `prismaTelegram`) pour éviter d'ouvrir
   * une TX sur Core qui ne peut pas vérifier les FK ni voir les writes du repository
   * sur l'autre DB.
   */
  protected transactionClient: AnyPrismaClient = prisma as unknown as AnyPrismaClient;

  /**
   * Préfixe pour les clés de cache
   */
  protected abstract cacheKeyPrefix: string;

  /**
   * Schémas de validation
   */
  protected abstract validationSchemas: {
    create: z.ZodSchema<CreateInput>;
    update: z.ZodSchema<UpdateInput>;
    query: z.ZodSchema<QueryParams>;
  };

  /**
   * Classes d'erreur utilisées par le service
   */
  protected abstract errorClasses: {
    notFound: new (message?: string) => Error;
    alreadyExists: new (message?: string) => Error;
    validation: new (message?: string) => Error;
  };

  /**
   * Accès typé au repository en tant que CrudRepository.
   * Les services dont le repository ne satisfait pas CrudRepository doivent surcharger
   * les méthodes CRUD correspondantes.
   */
  protected get crudRepo(): CrudRepository<T, CreateInput, UpdateInput, QueryParams> {
    return this.repository as unknown as CrudRepository<T, CreateInput, UpdateInput, QueryParams>;
  }

  /**
   * Invalide le cache d'une entité spécifique
   * @param id ID de l'entité
   */
  protected async invalidateEntityCache(id: number): Promise<void> {
    await cacheService.invalidate(`${this.cacheKeyPrefix}:${id}`);
  }
  
  /**
   * Invalide le cache des listes d'entités
   */
  protected async invalidateEntityListCache(): Promise<void> {
    await cacheService.invalidateByPattern(`${this.cacheKeyPrefix}*`);
  }
  
  /**
   * Valide les données d'entrée avec un schéma Zod
   * @param data Données à valider
   * @param schema Schéma de validation
   * @returns Données validées
   * @throws Erreur de validation si les données sont invalides
   */
  protected validateInput<T>(data: T, schema: z.ZodSchema<T>): T {
    const validationResult = schema.safeParse(data);
    if (!validationResult.success) {
      throw new this.errorClasses.validation(validationResult.error.message);
    }
    return validationResult.data;
  }

  /**
   * Récupère toutes les entités avec pagination, tri et filtrage
   * @param query Paramètres de requête
   * @returns Liste paginée d'entités
   */
  async getAll(query: QueryParams) {
    try {
      // Validate query parameters
      const validatedQuery = this.validateInput(query, this.validationSchemas.query);

      // Générer une clé de cache unique basée sur les paramètres de requête
      const cacheKey = `${this.cacheKeyPrefix}:list:${JSON.stringify(validatedQuery)}`;

      // Utiliser le service de cache pour récupérer ou mettre en cache les données
      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const result = await this.crudRepo.findAll(validatedQuery);
          
          // Extraire les informations de pagination pour le logging
          const paginationInfo: Record<string, unknown> = {
            count: result.data.length,
            total: result.pagination.total
          };
          
          // Ajouter page et limit si disponibles
          if (validatedQuery.page !== undefined) {
            paginationInfo.page = validatedQuery.page;
          }
          if (validatedQuery.limit !== undefined) {
            paginationInfo.limit = validatedQuery.limit;
          }
          
          logDeduplicator.info(`${this.constructor.name}: Entities retrieved successfully`, paginationInfo);
          return result;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      if (error instanceof this.errorClasses.validation) {
        throw error;
      }
      logDeduplicator.error(`Error fetching entities in ${this.constructor.name}:`, { error, query });
      throw error;
    }
  }

  /**
   * Récupère une entité par son ID
   * @param id ID de l'entité
   * @returns Entité trouvée
   * @throws Erreur si l'entité n'est pas trouvée
   */
  async getById(id: number) {
    try {
      // Utiliser le service de cache pour récupérer ou mettre en cache l'entité
      return await cacheService.getOrSet(
        `${this.cacheKeyPrefix}:${id}`,
        async () => {
          const entity = await this.crudRepo.findById(id);
          if (!entity) {
            throw new this.errorClasses.notFound();
          }
          logDeduplicator.info(`${this.constructor.name}: Entity retrieved successfully`, { id });
          return entity;
        },
        CACHE_TTL.MEDIUM
      );
    } catch (error) {
      if (error instanceof this.errorClasses.notFound) {
        throw error;
      }
      logDeduplicator.error(`Error fetching entity in ${this.constructor.name}:`, { error, id });
      throw error;
    }
  }

  /**
   * Crée une nouvelle entité
   * @param data Données de l'entité à créer
   * @returns Entité créée
   * @throws Erreur si l'entité existe déjà ou si les données sont invalides
   */
  async create(data: CreateInput) {
    try {
      // Validate input data
      const validatedData = this.validateInput(data, this.validationSchemas.create);

      // Utiliser le service de transaction pour la création
      const entity = await this.transactionClient.$transaction(async (tx) => {
        // Configurer le repository pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx as PrismaTransactionClient);
        
        // Vérifier si une entité avec le même identifiant existe déjà
        const existingEntity = await this.checkExists(validatedData);
        if (existingEntity) {
          throw new this.errorClasses.alreadyExists();
        }

        // Créer l'entité
        return this.crudRepo.create(validatedData);
      });

      // Réinitialiser le client Prisma
      this.repository.resetPrismaClient();

      // Mettre en cache la nouvelle entité
      const entityId = (entity as T & { id?: number | string }).id;
      if (entityId !== undefined) {
        await cacheService.getOrSet(
          `${this.cacheKeyPrefix}:${entityId}`,
          async () => entity,
          CACHE_TTL.MEDIUM
        );
      }

      // Invalider le cache des listes d'entités
      await this.invalidateEntityListCache();

      logDeduplicator.info(`${this.constructor.name}: Entity created successfully`, { id: entityId });
      return entity;
    } catch (error) {
      if (error instanceof this.errorClasses.alreadyExists || error instanceof this.errorClasses.validation) {
        throw error;
      }
      logDeduplicator.error(`Error creating entity in ${this.constructor.name}:`, { error, data });
      throw error;
    }
  }

  /**
   * Met à jour une entité existante
   * @param id ID de l'entité à mettre à jour
   * @param data Données de mise à jour
   * @returns Entité mise à jour
   * @throws Erreur si l'entité n'existe pas ou si les données sont invalides
   */
  async update(id: number, data: UpdateInput) {
    try {
      // Validate input data
      const validatedData = this.validateInput(data, this.validationSchemas.update);

      // Utiliser le service de transaction pour la mise à jour
      const updatedEntity = await this.transactionClient.$transaction(async (tx) => {
        // Configurer le repository pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx as PrismaTransactionClient);
        
        // Vérifier si l'entité existe
        const entity = await this.crudRepo.findById(id);
        if (!entity) {
          throw new this.errorClasses.notFound();
        }

        // Vérifier si une entité avec le même identifiant existe déjà
        if (await this.checkExistsForUpdate(id, validatedData)) {
          throw new this.errorClasses.alreadyExists();
        }

        // Mettre à jour l'entité
        return this.crudRepo.update(id, validatedData);
      });

      // Réinitialiser le client Prisma
      this.repository.resetPrismaClient();

      // Invalider le cache
      await this.invalidateEntityCache(id);
      await this.invalidateEntityListCache();

      // Mettre en cache l'entité mise à jour
      await cacheService.getOrSet(
        `${this.cacheKeyPrefix}:${id}`,
        async () => updatedEntity,
        CACHE_TTL.MEDIUM
      );

      logDeduplicator.info(`${this.constructor.name}: Entity updated successfully`, { id });
      return updatedEntity;
    } catch (error) {
      if (error instanceof this.errorClasses.notFound || 
          error instanceof this.errorClasses.alreadyExists || 
          error instanceof this.errorClasses.validation) {
        throw error;
      }
      logDeduplicator.error(`Error updating entity in ${this.constructor.name}:`, { error, id, data });
      throw error;
    }
  }

  /**
   * Supprime une entité
   * @param id ID de l'entité à supprimer
   * @throws Erreur si l'entité n'existe pas
   */
  async delete(id: number) {
    try {
      // Utiliser le service de transaction pour la suppression
      await this.transactionClient.$transaction(async (tx) => {
        // Configurer le repository pour utiliser le client transactionnel
        this.repository.setPrismaClient(tx as PrismaTransactionClient);

        // Vérifier si l'entité existe
        const entity = await this.crudRepo.findById(id);
        if (!entity) {
          throw new this.errorClasses.notFound();
        }

        // Vérifier si l'entité peut être supprimée
        await this.checkCanDelete(id);

        // Supprimer l'entité
        await this.crudRepo.delete(id);
      });

      // Réinitialiser le client Prisma
      this.repository.resetPrismaClient();

      // Invalider le cache
      await this.invalidateEntityCache(id);
      await this.invalidateEntityListCache();

      logDeduplicator.info(`${this.constructor.name}: Entity deleted successfully`, { id });
    } catch (error) {
      if (error instanceof this.errorClasses.notFound) {
        throw error;
      }
      logDeduplicator.error(`Error deleting entity in ${this.constructor.name}:`, { error, id });
      throw error;
    }
  }

  /**
   * Vérifie si une entité avec les données données existe déjà
   * @param data Données de l'entité
   * @returns true si l'entité existe déjà, false sinon
   */
  protected abstract checkExists(data: CreateInput): Promise<boolean>;

  /**
   * Vérifie si une entité avec les données de mise à jour existe déjà
   * @param id ID de l'entité à mettre à jour
   * @param data Données de mise à jour
   * @returns true si une autre entité avec les mêmes données existe déjà, false sinon
   */
  protected abstract checkExistsForUpdate(id: number, data: UpdateInput): Promise<boolean>;

  /**
   * Vérifie si une entité peut être supprimée
   * @param id ID de l'entité à supprimer
   * @throws Erreur si l'entité ne peut pas être supprimée
   */
  protected abstract checkCanDelete(id: number): Promise<void>;
} 