import { PublicGoodRepository } from '../interfaces/publicgood.repository.interface';
import { PublicGoodResponse, PublicGoodCreateInput, PublicGoodUpdateInput } from '../../types/publicgood.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { ProjectStatus } from '../../types/prisma-enums';
import { prismaContent } from '../../core/prisma.content.service';
import {
  attachSubmitter,
  attachReviewedBy,
  attachSubmitterAndReviewerOne
} from '../../utils/cross-db-enrich';

export class PrismaPublicGoodRepository extends BasePrismaRepository implements PublicGoodRepository {
  constructor() {
    super();
    // PublicGood lives in the Content DB. User remains in Core DB,
    // so submittedBy/reviewedBy nested objects are produced via cross-db enrichment.
    this.setPrismaClient(prismaContent as unknown as typeof this.prismaClient, true);
  }

  /** Enrich an array of public good rows with submittedBy + reviewedBy user objects. */
  private async enrichList<T extends Record<string, unknown>>(rows: T[]): Promise<Array<T & { submittedBy: unknown; reviewedBy: unknown }>> {
    const withSubmitter = await attachSubmitter(rows, 'submitterId');
    const withReviewer = await attachReviewedBy(withSubmitter, 'reviewerId');
    return withReviewer as unknown as Array<T & { submittedBy: unknown; reviewedBy: unknown }>;
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    status?: ProjectStatus;
    category?: string;
    developmentStatus?: string;
  }): Promise<{
    data: PublicGoodResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 50,
        sort = 'submittedAt',
        order = 'desc',
        search,
        status,
        category,
        developmentStatus
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where: any = {};
      
      // Filtrer par status
      if (status) {
        where.status = status;
      }
      
      // Filtrer par catégorie
      if (category) {
        where.category = { contains: category, mode: 'insensitive' };
      }
      
      // Filtrer par development status
      if (developmentStatus) {
        where.developmentStatus = developmentStatus;
      }
      
      // Recherche dans name, description, problemSolved, technologies
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { problemSolved: { contains: search, mode: 'insensitive' } },
          { technologies: { has: search } }
        ];
      }
      
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.publicGood.count({ where });
      const publicGoods = await this.prismaClient.publicGood.findMany({
        where,
        skip,
        take,
        orderBy,
        // reviewNotes = internal moderator notes. findAll is unauthenticated, so
        // they must never ship here (kept on the moderator/submitter paths).
        omit: { reviewNotes: true }
      });

      const enriched = await this.enrichList(publicGoods as Array<Record<string, unknown>>);
      return {
        data: enriched as unknown as PublicGoodResponse[],
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all public goods', params);
  }

  async findById(id: number): Promise<PublicGoodResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const publicGood = await this.prismaClient.publicGood.findUnique({
          where: { id },
          // Public GET /:id (optional auth) — internal moderator notes must not ship.
          omit: { reviewNotes: true }
        });
        const enriched = await attachSubmitterAndReviewerOne(
          publicGood as Record<string, unknown> | null,
          'submitterId',
          'reviewerId'
        );
        return enriched as unknown as PublicGoodResponse | null;
      },
      'finding public good by ID',
      { id }
    );
  }

  async create(data: PublicGoodCreateInput): Promise<PublicGoodResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const publicGood = await this.prismaClient.publicGood.create({
          data: {
            ...data,
            submitterId: data.submitterId!,
            status: 'PENDING' as ProjectStatus
          }
        });

        const enriched = await attachSubmitterAndReviewerOne(
          publicGood as Record<string, unknown>,
          'submitterId',
          'reviewerId'
        );
        return enriched as unknown as PublicGoodResponse;
      },
      'creating public good',
      { name: data.name }
    );
  }

  async update(id: number, data: PublicGoodUpdateInput): Promise<PublicGoodResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const publicGood = await this.prismaClient.publicGood.update({
          where: { id },
          data
        });

        const enriched = await attachSubmitterAndReviewerOne(
          publicGood as Record<string, unknown>,
          'submitterId',
          'reviewerId'
        );
        return enriched as unknown as PublicGoodResponse;
      },
      'updating public good',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.publicGood.delete({
          where: { id }
        });
      },
      'deleting public good',
      { id }
    );
  }

  async existsByName(name: string): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const publicGood = await this.prismaClient.publicGood.findFirst({
          where: { name }
        });
        return !!publicGood;
      },
      'checking if public good exists by name',
      { name }
    );
  }

  async findBySubmitter(submitterId: number, params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
  }): Promise<{
    data: PublicGoodResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 50,
        sort = 'submittedAt',
        order = 'desc'
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where = { submitterId };
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.publicGood.count({ where });
      const publicGoods = await this.prismaClient.publicGood.findMany({
        where,
        skip,
        take,
        orderBy
      });

      const enriched = await this.enrichList(publicGoods as Array<Record<string, unknown>>);
      return {
        data: enriched as unknown as PublicGoodResponse[],
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding public goods by submitter', { submitterId, ...params });
  }

  async findPending(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
  }): Promise<{
    data: PublicGoodResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 50,
        sort = 'submittedAt',
        order = 'desc'
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where = { status: 'PENDING' as ProjectStatus };
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.publicGood.count({ where });
      const publicGoods = await this.prismaClient.publicGood.findMany({
        where,
        skip,
        take,
        orderBy
      });

      const enriched = await this.enrichList(publicGoods as Array<Record<string, unknown>>);
      return {
        data: enriched as unknown as PublicGoodResponse[],
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding pending public goods', params);
  }

  async review(id: number, reviewData: {
    status: ProjectStatus;
    reviewerId: number;
    reviewNotes?: string;
  }): Promise<PublicGoodResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const publicGood = await this.prismaClient.publicGood.update({
          where: { id },
          data: {
            status: reviewData.status,
            reviewerId: reviewData.reviewerId,
            reviewedAt: new Date(),
            reviewNotes: reviewData.reviewNotes
          }
        });

        const enriched = await attachSubmitterAndReviewerOne(
          publicGood as Record<string, unknown>,
          'submitterId',
          'reviewerId'
        );
        return enriched as unknown as PublicGoodResponse;
      },
      'reviewing public good',
      { id, ...reviewData }
    );
  }

  async isOwner(id: number, userId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const publicGood = await this.prismaClient.publicGood.findFirst({
          where: { 
            id,
            submitterId: userId
          }
        });
        return !!publicGood;
      },
      'checking if user is owner',
      { id, userId }
    );
  }
}

