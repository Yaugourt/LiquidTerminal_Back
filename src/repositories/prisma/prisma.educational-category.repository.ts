import { EducationalCategoryRepository } from '../interfaces/educational-category.repository.interface';
import { 
  EducationalCategoryResponse, 
  EducationalCategoryCreateInput, 
  EducationalCategoryUpdateInput
} from '../../types/educational.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { prismaContent } from '../../core/prisma.content.service';
import { attachCreator, attachCreatorOne } from '../../utils/cross-db-enrich';

export class PrismaEducationalCategoryRepository extends BasePrismaRepository implements EducationalCategoryRepository {
  constructor() {
    super();
    // EducationalCategory lives in the Content DB; User remains in Core,
    // so creator info must be attached via cross-db enrichment helpers.
    this.setPrismaClient(prismaContent as unknown as typeof this.prismaClient);
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    createdBy?: number;
  }): Promise<{
    data: EducationalCategoryResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 10,
        sort = 'createdAt',
        order = 'desc',
        search,
        createdBy
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where: any = {};
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ];
      }
      if (createdBy) {
        where.createdBy = createdBy;
      }
      
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.educationalCategory.count({ where });
      const categories = await this.prismaClient.educationalCategory.findMany({
        where,
        skip,
        take,
        orderBy
      });

      const enriched = await attachCreator(categories as Array<Record<string, unknown>>, 'createdBy');

      return {
        data: enriched as unknown as EducationalCategoryResponse[],
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all educational categories', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, createdBy: params.createdBy });
  }

  async findById(id: number): Promise<EducationalCategoryResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalCategory.findUnique({
          where: { id }
        });
        const enriched = await attachCreatorOne(row as Record<string, unknown> | null, 'createdBy');
        return enriched as unknown as EducationalCategoryResponse | null;
      },
      'finding educational category by ID',
      { id }
    );
  }

  async create(data: EducationalCategoryCreateInput): Promise<EducationalCategoryResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalCategory.create({
          data: {
            name: data.name,
            description: data.description,
            createdBy: data.createdBy
          }
        });
        const enriched = await attachCreatorOne(row as Record<string, unknown>, 'createdBy');
        return enriched as unknown as EducationalCategoryResponse;
      },
      'creating educational category',
      { name: data.name, createdBy: data.createdBy }
    );
  }

  async update(id: number, data: EducationalCategoryUpdateInput): Promise<EducationalCategoryResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalCategory.update({
          where: { id },
          data
        });
        const enriched = await attachCreatorOne(row as Record<string, unknown>, 'createdBy');
        return enriched as unknown as EducationalCategoryResponse;
      },
      'updating educational category',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.educationalCategory.delete({
          where: { id }
        });
      },
      'deleting educational category',
      { id }
    );
  }

  async existsByName(name: string): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const category = await this.prismaClient.educationalCategory.findFirst({
          where: { name }
        });
        return !!category;
      },
      'checking if educational category exists by name',
      { name }
    );
  }

  async findByCreator(createdBy: number): Promise<EducationalCategoryResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        const rows = await this.prismaClient.educationalCategory.findMany({
          where: { createdBy },
          orderBy: { createdAt: 'desc' }
        });
        const enriched = await attachCreator(rows as Array<Record<string, unknown>>, 'createdBy');
        return enriched as unknown as EducationalCategoryResponse[];
      },
      'finding educational categories by creator',
      { createdBy }
    );
  }

  async findByName(name: string): Promise<EducationalCategoryResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const row = await this.prismaClient.educationalCategory.findFirst({
          where: { name }
        });
        const enriched = await attachCreatorOne(row as Record<string, unknown> | null, 'createdBy');
        return enriched as unknown as EducationalCategoryResponse | null;
      },
      'finding educational category by name',
      { name }
    );
  }

  async getResourcesByCategory(categoryId: number): Promise<any[]> {
    return this.executeWithErrorHandling(
      async () => {
        const resourceCategories = await this.prismaClient.educationalResourceCategory.findMany({
          where: { categoryId },
          include: {
            resource: true
          }
        });

        const resources = resourceCategories.map((rc: any) => rc.resource);
        return await attachCreator(resources as Array<Record<string, unknown>>, 'addedBy');
      },
      'finding resources by educational category',
      { categoryId }
    );
  }
} 