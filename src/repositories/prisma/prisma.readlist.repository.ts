import { ReadListRepository } from '../interfaces/readlist.repository.interface';
import { 
  ReadListResponse, 
  ReadListCreateInput, 
  ReadListUpdateInput,
  ReadListSummaryResponse
} from '../../types/readlist.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';

export class PrismaReadListRepository extends BasePrismaRepository implements ReadListRepository {
  // Helper pour les includes répétitifs
  private readonly includeConfig = {
    creator: {
      select: BasePrismaRepository.UserSelect
    },
    items: {
      include: {
        resource: {
          include: {
            creator: {
              select: BasePrismaRepository.UserSelect
            }
          }
        }
      },
      orderBy: [
        { order: 'asc' as const },
        { addedAt: 'asc' as const }
      ]
    }
  };

  private readonly summaryIncludeConfig = {
    creator: {
      select: BasePrismaRepository.UserSelect
    },
    _count: {
      select: {
        items: true
      }
    }
  };

  async findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    userId?: number;
    isPublic?: boolean;
  }): Promise<{
    data: ReadListSummaryResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 10,
        sort = 'updatedAt',
        order = 'desc',
        search,
        userId,
        isPublic
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      const where = this.buildWhereClause({ search, userId, isPublic });
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.readList.count({ where });
      const readLists = await this.prismaClient.readList.findMany({
        where,
        skip,
        take,
        orderBy,
        include: this.summaryIncludeConfig
      });

      // Transform data to include itemsCount
      const data = readLists.map((readList: any) => ({
        ...readList,
        itemsCount: readList._count.items,
        _count: undefined
      }));

      return {
        data,
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all read lists', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, userId: params.userId, isPublic: params.isPublic });
  }

  async findById(id: number): Promise<ReadListResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readList.findUnique({
          where: { id },
          include: this.includeConfig
        });
      },
      'finding read list by ID',
      { id }
    );
  }

  async findSummaryById(id: number): Promise<ReadListSummaryResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.findUnique({
          where: { id },
          include: this.summaryIncludeConfig
        });

        if (!readList) return null;

        return {
          ...readList,
          itemsCount: readList._count.items,
          _count: undefined
        };
      },
      'finding read list summary by ID',
      { id }
    );
  }

  async create(data: ReadListCreateInput): Promise<ReadListResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readList.create({
          data: {
            name: data.name,
            description: data.description,
            isPublic: data.isPublic,
            creator: {
              connect: { id: data.userId }
            }
          },
          include: this.includeConfig
        });
      },
      'creating read list',
      { name: data.name, userId: data.userId }
    );
  }

  async update(id: number, data: ReadListUpdateInput): Promise<ReadListResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readList.update({
          where: { id },
          data,
          include: this.includeConfig
        });
      },
      'updating read list',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.readList.delete({
          where: { id }
        });
      },
      'deleting read list',
      { id }
    );
  }

  async existsByNameAndUser(name: string, userId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.findFirst({
          where: { name, userId }
        });
        return !!readList;
      },
      'checking if read list exists by name and user',
      { name, userId }
    );
  }

  async findByUser(userId: number): Promise<ReadListSummaryResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        const readLists = await this.prismaClient.readList.findMany({
          where: { userId },
          include: this.summaryIncludeConfig,
          orderBy: { updatedAt: 'desc' }
        });

        return readLists.map((readList: any) => ({
          ...readList,
          itemsCount: readList._count.items,
          _count: undefined
        }));
      },
      'finding read lists by user',
      { userId }
    );
  }

  async findPublicLists(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
  }): Promise<{
    data: ReadListSummaryResponse[];
    pagination: BasePagination;
  }> {
    return this.findAll({ ...params, isPublic: true });
  }

  async hasAccess(readListId: number, userId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.findUnique({
          where: { id: readListId },
          select: { userId: true, isPublic: true }
        });

        if (!readList) return false;
        return readList.userId === userId || readList.isPublic;
      },
      'checking read list access',
      { readListId, userId }
    );
  }

  async updateItemsCount(readListId: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        // Cette méthode peut être utilisée pour maintenir un compteur dénormalisé si nécessaire
        // Pour l'instant, nous utilisons _count dans les requêtes
        // Pas d'action nécessaire car on utilise _count dynamiquement
      },
      'updating items count',
      { readListId }
    );
  }
} 