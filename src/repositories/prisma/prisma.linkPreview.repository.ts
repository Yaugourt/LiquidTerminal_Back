import { LinkPreviewRepository } from '../interfaces/linkPreview.repository.interface';
import { 
  LinkPreviewResponse, 
  LinkPreviewCreateInput, 
  LinkPreviewUpdateInput
} from '../../types/linkPreview.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { prismaContent } from '../../core/prisma.content.service';

export class PrismaLinkPreviewRepository extends BasePrismaRepository implements LinkPreviewRepository {
  constructor() {
    super();
    // LinkPreview lives in the Content DB after the multi-DB split.
    this.setPrismaClient(prismaContent as unknown as typeof this.prismaClient, true);
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
  }): Promise<{
    data: LinkPreviewResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 10,
        sort = 'createdAt',
        order = 'desc',
        search
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where: any = {};
      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { siteName: { contains: search, mode: 'insensitive' } },
          { url: { contains: search, mode: 'insensitive' } }
        ];
      }
      
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.linkPreview.count({ where });
      const linkPreviews = await this.prismaClient.linkPreview.findMany({
        where,
        skip,
        take,
        orderBy
      });

      return {
        data: linkPreviews,
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all link previews', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search });
  }

  async findById(id: string): Promise<LinkPreviewResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.linkPreview.findUnique({
          where: { id }
        });
      },
      'finding link preview by ID',
      { id }
    );
  }

  async create(data: LinkPreviewCreateInput): Promise<LinkPreviewResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.linkPreview.create({
          data
        });
      },
      'creating link preview',
      { url: data.url }
    );
  }

  async update(id: string, data: LinkPreviewUpdateInput): Promise<LinkPreviewResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.linkPreview.update({
          where: { id },
          data
        });
      },
      'updating link preview',
      { id, ...data }
    );
  }

  async delete(id: string): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.linkPreview.delete({
          where: { id }
        });
      },
      'deleting link preview',
      { id }
    );
  }

  async existsByUrl(url: string): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const linkPreview = await this.prismaClient.linkPreview.findFirst({
          where: { url }
        });
        return !!linkPreview;
      },
      'checking if link preview exists by URL',
      { url }
    );
  }

  async findByUrl(url: string): Promise<LinkPreviewResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.linkPreview.findFirst({
          where: { url }
        });
      },
      'finding link preview by URL',
      { url }
    );
  }

  async upsert(url: string, data: LinkPreviewCreateInput): Promise<LinkPreviewResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.linkPreview.upsert({
          where: { url },
          update: {
            ...data,
            updatedAt: new Date()
          },
          create: data
        });
      },
      'upserting link preview',
      { url }
    );
  }

  async findExpiredPreviews(expiredBefore: Date, limit: number = 50): Promise<LinkPreviewResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.linkPreview.findMany({
          where: {
            updatedAt: {
              lt: expiredBefore
            }
          },
          take: limit,
          orderBy: { updatedAt: 'asc' }
        });
      },
      'finding expired link previews',
      { expiredBefore, limit }
    );
  }
} 