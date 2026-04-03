import { PrismaClient } from '@prisma/client';
import { prisma } from '../../core/prisma.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { BasePagination } from '../../types/common.types';

export type PrismaTransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const REPOSITORY_LOG_ERROR_MESSAGE_MAX = 1000;

/** Avoid logging raw Error/Prisma objects (validation errors embed full query payloads). */
function serializeRepositoryError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    const meta: Record<string, string> = {
      errorName: error.name,
      errorMessage:
        error.message.length > REPOSITORY_LOG_ERROR_MESSAGE_MAX
          ? `${error.message.slice(0, REPOSITORY_LOG_ERROR_MESSAGE_MAX)}…`
          : error.message,
    };
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'string'
    ) {
      meta.errorCode = (error as { code: string }).code;
    }
    return meta;
  }
  return { errorMessage: String(error) };
}

export type ExecuteWithErrorHandlingOptions = {
  /** When false, skip per-operation "Starting" / "completed successfully" info logs (context still attached on errors). */
  verboseSuccess?: boolean;
};

export abstract class BasePrismaRepository {
  protected prismaClient: PrismaClient | PrismaTransactionClient = prisma;

  // Constantes communes pour les sélections
  protected static readonly UserSelect = {
    id: true,
    name: true,
    email: true
  } as const;

  protected static readonly CreatorInclude = {
    creator: { select: BasePrismaRepository.UserSelect }
  } as const;

  setPrismaClient(prismaClient: PrismaClient | PrismaTransactionClient): void {
    this.prismaClient = prismaClient;
    logDeduplicator.info(`Prisma client updated in ${this.constructor.name}`);
  }

  resetPrismaClient(): void {
    this.prismaClient = prisma;
    logDeduplicator.info(`Prisma client reset to default in ${this.constructor.name}`);
  }

  // Helper pour try/catch avec logging
  protected async executeWithErrorHandling<T>(
    operation: () => Promise<T>,
    operationName: string,
    context?: Record<string, unknown>,
    options?: ExecuteWithErrorHandlingOptions
  ): Promise<T> {
    const verboseSuccess = options?.verboseSuccess !== false;
    try {
      if (context && verboseSuccess) {
        logDeduplicator.info(`Starting ${operationName}`, context);
      }
      const result = await operation();
      if (context && verboseSuccess) {
        logDeduplicator.info(`${operationName} completed successfully`, context);
      }
      return result;
    } catch (error) {
      const payload: Record<string, unknown> = {
        ...serializeRepositoryError(error),
        ...(context ?? {}),
      };
      logDeduplicator.error(`Error in ${operationName}`, payload);
      throw error;
    }
  }

  // Helper pour construire la pagination
  protected buildPagination(total: number, page: number, limit: number): BasePagination {
    const totalPages = Math.ceil(total / limit);
    return {
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1
    };
  }

  // Helper pour valider les paramètres de pagination
  protected validatePaginationParams(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
  }): void {
    const { page = 1, limit = 10, order = 'desc' } = params;
    
    if (page < 1) {
      throw new Error('Page must be >= 1');
    }
    if (limit < 1 || limit > 100) {
      throw new Error('Limit must be between 1 and 100');
    }
    if (order !== 'asc' && order !== 'desc') {
      throw new Error('Order must be "asc" or "desc"');
    }
  }

  // Helper pour construire les conditions WHERE
  protected buildWhereClause(params: {
    search?: string;
    userId?: number;
    isPublic?: boolean;
    addedBy?: number;
    categoryId?: number;
  }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } }
      ];
    }
    
    if (params.userId !== undefined) {
      where.userId = params.userId;
    }
    
    if (params.isPublic !== undefined) {
      where.isPublic = params.isPublic;
    }
    
    if (params.addedBy !== undefined) {
      where.addedBy = params.addedBy;
    }
    
    if (params.categoryId !== undefined) {
      where.categories = {
        some: { categoryId: params.categoryId }
      };
    }
    
    return where;
  }

  // Helper pour construire les paramètres de requête
  protected buildQueryParams(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
  }): {
    skip: number;
    take: number;
    orderBy: Record<string, string>;
  } {
    const { page = 1, limit = 10, sort = 'createdAt', order = 'desc' } = params;
    
    // Parse en int pour éviter que des strings passent à Prisma (query params HTTP)
    const pageInt = typeof page === 'string' ? parseInt(page, 10) : page;
    const limitInt = typeof limit === 'string' ? parseInt(limit, 10) : limit;
    
    return {
      skip: (pageInt - 1) * limitInt,
      take: limitInt,
      orderBy: { [sort]: order }
    };
  }
}
