import { EducationalResourceRepository } from '../interfaces/educational-resource.repository.interface';
import {
  EducationalResourceResponse,
  EducationalResourceCreateInput,
  EducationalResourceUpdateInput,
  EducationalResourceCategoryCreateInput,
  EducationalResourceCategoryResponse
} from '../../types/educational.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { ResourceStatus } from '../../types/prisma-enums';
import { prismaContent } from '../../core/prisma.content.service';
import {
  attachCreator,
  attachReviewer,
  attachAssigner
} from '../../utils/cross-db-enrich';

export class PrismaEducationalResourceRepository extends BasePrismaRepository implements EducationalResourceRepository {
  constructor() {
    super();
    // EducationalResource lives in the Content DB. User remains in Core DB,
    // so creator/reviewer/assigner are attached via cross-db enrichment.
    this.setPrismaClient(prismaContent as unknown as typeof this.prismaClient, true);
  }

  // Helper pour les includes répétitifs (intra-Content uniquement)
  private readonly includeConfig = {
    linkPreview: {
      select: {
        id: true,
        title: true,
        description: true,
        image: true,
        siteName: true,
        favicon: true
      }
    },
    categories: {
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true
          }
        }
      }
    }
  };

  /**
   * Apply cross-db user enrichment to an array of educational resources.
   * Attaches `creator`, `reviewer`, and (per-row) `categories[].assigner`.
   */
  private async enrichResources<T extends { categories?: Array<Record<string, unknown>> }>(
    rows: T[]
  ): Promise<Array<T & { creator: unknown; reviewer: unknown }>> {
    const withCreator = await attachCreator(rows as Array<Record<string, unknown>>, 'addedBy');
    const withReviewer = await attachReviewer(withCreator, 'reviewedBy');
    for (const row of withReviewer) {
      const cats = (row as unknown as { categories?: Array<Record<string, unknown>> }).categories;
      if (Array.isArray(cats) && cats.length > 0) {
        const enrichedCats = await attachAssigner(cats, 'assignedBy');
        (row as unknown as { categories: unknown }).categories = enrichedCats;
      }
    }
    return withReviewer as unknown as Array<T & { creator: unknown; reviewer: unknown }>;
  }

  private async enrichResourceOne<T extends { categories?: Array<Record<string, unknown>> }>(
    row: T | null
  ): Promise<(T & { creator: unknown; reviewer: unknown }) | null> {
    if (!row) return null;
    const [enriched] = await this.enrichResources([row]);
    return enriched;
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    addedBy?: number;
    categoryId?: number;
    status?: ResourceStatus;
  }): Promise<{
    data: EducationalResourceResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 10,
        sort = 'createdAt',
        order = 'desc',
        search,
        addedBy,
        categoryId,
        status
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });

      const where: any = {};
      if (search) {
        where.url = { contains: search, mode: 'insensitive' };
      }
      if (addedBy) {
        where.addedBy = addedBy;
      }
      if (categoryId) {
        where.categories = {
          some: { categoryId }
        };
      }
      if (status) {
        where.status = status;
      }

      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.educationalResource.count({ where });
      const resources = await this.prismaClient.educationalResource.findMany({
        where,
        skip,
        take,
        orderBy,
        include: this.includeConfig
      });

      const enriched = await this.enrichResources(resources as Array<Record<string, unknown>>);
      return {
        data: enriched as unknown as EducationalResourceResponse[],
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all educational resources', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, addedBy: params.addedBy, categoryId: params.categoryId });
  }

  async findById(id: number): Promise<EducationalResourceResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalResource.findUnique({
          where: { id },
          include: this.includeConfig
        });
        const enriched = await this.enrichResourceOne(row as Record<string, unknown> | null);
        return enriched as unknown as EducationalResourceResponse | null;
      },
      'finding educational resource by ID',
      { id }
    );
  }

  async create(data: EducationalResourceCreateInput): Promise<EducationalResourceResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const { categoryIds, ...resourceData } = data;

        const row = await this.prismaClient.educationalResource.create({
          data: {
            ...resourceData,
            ...(categoryIds && categoryIds.length > 0 ? {
              categories: {
                create: categoryIds.map(categoryId => ({
                  categoryId,
                  assignedBy: data.addedBy
                }))
              }
            } : {})
          },
          include: this.includeConfig
        });
        const enriched = await this.enrichResourceOne(row as Record<string, unknown>);
        return enriched as unknown as EducationalResourceResponse;
      },
      'creating educational resource',
      { url: data.url, addedBy: data.addedBy }
    );
  }

  async update(id: number, data: EducationalResourceUpdateInput): Promise<EducationalResourceResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalResource.update({
          where: { id },
          data,
          include: this.includeConfig
        });
        const enriched = await this.enrichResourceOne(row as Record<string, unknown>);
        return enriched as unknown as EducationalResourceResponse;
      },
      'updating educational resource',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.educationalResource.delete({
          where: { id }
        });
      },
      'deleting educational resource',
      { id }
    );
  }

  async existsByUrl(url: string): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const resource = await this.prismaClient.educationalResource.findFirst({
          where: { url }
        });
        return !!resource;
      },
      'checking if educational resource exists by URL',
      { url }
    );
  }

  async findByCreator(userId: number): Promise<EducationalResourceResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        const rows = await this.prismaClient.educationalResource.findMany({
          where: { addedBy: userId },
          include: this.includeConfig,
          orderBy: { createdAt: 'desc' }
        });
        const enriched = await this.enrichResources(rows as Array<Record<string, unknown>>);
        return enriched as unknown as EducationalResourceResponse[];
      },
      'finding educational resources by creator',
      { userId }
    );
  }

  async findByCategory(categoryId: number): Promise<EducationalResourceResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        const resourceCategories = await this.prismaClient.educationalResourceCategory.findMany({
          where: { categoryId },
          include: {
            resource: {
              include: this.includeConfig
            }
          }
        });

        const resources = resourceCategories.map((rc: any) => rc.resource);
        const enriched = await this.enrichResources(resources as Array<Record<string, unknown>>);
        return enriched as unknown as EducationalResourceResponse[];
      },
      'finding educational resources by category',
      { categoryId }
    );
  }

  async assignToCategory(data: EducationalResourceCategoryCreateInput): Promise<EducationalResourceCategoryResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalResourceCategory.create({
          data,
          include: {
            category: {
              select: {
                id: true,
                name: true,
                description: true
              }
            }
          }
        });
        const [enriched] = await attachAssigner([row as Record<string, unknown>], 'assignedBy');
        return enriched as unknown as EducationalResourceCategoryResponse;
      },
      'assigning resource to category',
      { resourceId: data.resourceId, categoryId: data.categoryId, assignedBy: data.assignedBy }
    );
  }

  async removeFromCategory(resourceId: number, categoryId: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.educationalResourceCategory.deleteMany({
          where: {
            resourceId,
            categoryId
          }
        });
      },
      'removing resource from category',
      { resourceId, categoryId }
    );
  }

  async isAssignedToCategory(resourceId: number, categoryId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const assignment = await this.prismaClient.educationalResourceCategory.findFirst({
          where: {
            resourceId,
            categoryId
          }
        });
        return !!assignment;
      },
      'checking if resource is assigned to category',
      { resourceId, categoryId }
    );
  }

  async getResourceAssignments(resourceId: number): Promise<EducationalResourceCategoryResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        const rows = await this.prismaClient.educationalResourceCategory.findMany({
          where: { resourceId },
          include: {
            category: {
              select: {
                id: true,
                name: true,
                description: true
              }
            }
          }
        });
        const enriched = await attachAssigner(rows as Array<Record<string, unknown>>, 'assignedBy');
        return enriched as unknown as EducationalResourceCategoryResponse[];
      },
      'getting resource assignments',
      { resourceId }
    );
  }

  async findByUrl(url: string): Promise<EducationalResourceResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalResource.findFirst({
          where: { url },
          include: this.includeConfig
        });
        const enriched = await this.enrichResourceOne(row as Record<string, unknown> | null);
        return enriched as unknown as EducationalResourceResponse | null;
      },
      'finding resource by URL',
      { url }
    );
  }

  async getResourceCategories(resourceId: number): Promise<any[]> {
    return this.executeWithErrorHandling(
      async () => {
        const assignments = await this.prismaClient.educationalResourceCategory.findMany({
          where: { resourceId },
          include: {
            category: {
              select: {
                id: true,
                name: true,
                description: true
              }
            }
          }
        });

        return assignments.map((assignment: any) => assignment.category);
      },
      'getting resource categories',
      { resourceId }
    );
  }

  // ==================== MODERATION METHODS ====================

  async findPending(params: {
    page?: number;
    limit?: number;
  }): Promise<{
    data: EducationalResourceResponse[];
    pagination: BasePagination;
  }> {
    return this.findAll({
      ...params,
      status: 'PENDING' as ResourceStatus
    });
  }

  async countPending(): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.educationalResource.count({
          where: { status: 'PENDING' }
        });
      },
      'counting pending resources'
    );
  }

  async updateReviewStatus(
    id: number,
    status: ResourceStatus,
    reviewerId: number,
    notes?: string
  ): Promise<EducationalResourceResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalResource.update({
          where: { id },
          data: {
            status,
            reviewedAt: new Date(),
            reviewedBy: reviewerId,
            reviewNotes: notes
          },
          include: this.includeConfig
        });
        const enriched = await this.enrichResourceOne(row as Record<string, unknown>);
        return enriched as unknown as EducationalResourceResponse;
      },
      'updating resource review status',
      { id, status, reviewerId }
    );
  }

  async findByStatus(status: ResourceStatus): Promise<EducationalResourceResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        const rows = await this.prismaClient.educationalResource.findMany({
          where: { status },
          include: this.includeConfig,
          orderBy: { createdAt: 'desc' }
        });
        const enriched = await this.enrichResources(rows as Array<Record<string, unknown>>);
        return enriched as unknown as EducationalResourceResponse[];
      },
      'finding resources by status',
      { status }
    );
  }
}
