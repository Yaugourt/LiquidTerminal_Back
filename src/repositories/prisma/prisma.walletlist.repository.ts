import { WalletListRepository } from '../interfaces/walletlist.repository.interface';
import { 
  WalletListResponse, 
  WalletListCreateInput, 
  WalletListUpdateInput,
  WalletListSummaryResponse
} from '../../types/walletlist.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';

export class PrismaWalletListRepository extends BasePrismaRepository implements WalletListRepository {
  // Helper pour les includes répétitifs
  private readonly includeConfig = {
    creator: {
      select: BasePrismaRepository.UserSelect
    },
    items: {
      include: {
        userWallet: {
          include: {
            User: {
              select: BasePrismaRepository.UserSelect
            },
            Wallet: {
              select: {
                id: true,
                address: true,
                addedAt: true
              }
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
    data: WalletListSummaryResponse[];
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

      const total = await this.prismaClient.walletList.count({ where });
      const walletLists = await this.prismaClient.walletList.findMany({
        where,
        skip,
        take,
        orderBy,
        include: this.summaryIncludeConfig
      });

      // Transform data to include itemsCount
      const data = walletLists.map((walletList: any) => ({
        ...walletList,
        itemsCount: walletList._count.items,
        _count: undefined
      }));

      return {
        data,
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all wallet lists', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, userId: params.userId, isPublic: params.isPublic });
  }

  async findById(id: number): Promise<WalletListResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletList.findUnique({
          where: { id },
          include: this.includeConfig
        });
      },
      'finding wallet list by ID',
      { id }
    );
  }

  async findSummaryById(id: number): Promise<WalletListSummaryResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const walletList = await this.prismaClient.walletList.findUnique({
          where: { id },
          include: this.summaryIncludeConfig
        });

        if (!walletList) return null;

        return {
          ...walletList,
          itemsCount: walletList._count.items,
          _count: undefined
        };
      },
      'finding wallet list summary by ID',
      { id }
    );
  }

  async create(data: WalletListCreateInput): Promise<WalletListResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletList.create({
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
      'creating wallet list',
      { name: data.name, userId: data.userId }
    );
  }

  async update(id: number, data: WalletListUpdateInput): Promise<WalletListResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletList.update({
          where: { id },
          data,
          include: this.includeConfig
        });
      },
      'updating wallet list',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.walletList.delete({
          where: { id }
        });
      },
      'deleting wallet list',
      { id }
    );
  }

  async existsByNameAndUser(name: string, userId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const walletList = await this.prismaClient.walletList.findFirst({
          where: { name, userId }
        });
        return !!walletList;
      },
      'checking if wallet list exists by name and user',
      { name, userId }
    );
  }

  async findByUser(userId: number): Promise<WalletListSummaryResponse[]> {
    return this.executeWithErrorHandling(
      async () => {
        const walletLists = await this.prismaClient.walletList.findMany({
          where: { userId },
          include: this.summaryIncludeConfig,
          orderBy: { updatedAt: 'desc' }
        });

        return walletLists.map((walletList: any) => ({
          ...walletList,
          itemsCount: walletList._count.items,
          _count: undefined
        }));
      },
      'finding wallet lists by user',
      { userId }
    );
  }

  async countByUser(userId: number): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletList.count({
          where: { userId }
        });
      },
      'counting wallet lists by user',
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
    data: WalletListSummaryResponse[];
    pagination: BasePagination;
  }> {
    return this.findAll({ ...params, isPublic: true });
  }

  async hasAccess(walletListId: number, userId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const walletList = await this.prismaClient.walletList.findUnique({
          where: { id: walletListId },
          select: { userId: true, isPublic: true }
        });

        if (!walletList) return false;
        return walletList.userId === userId || walletList.isPublic;
      },
      'checking wallet list access',
      { walletListId, userId }
    );
  }

  async isOwner(walletListId: number, userId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const walletList = await this.prismaClient.walletList.findUnique({
          where: { id: walletListId },
          select: { userId: true }
        });

        return !!walletList && walletList.userId === userId;
      },
      'checking wallet list ownership',
      { walletListId, userId }
    );
  }

  async updateItemsCount(walletListId: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        // Cette méthode peut être utilisée pour maintenir un compteur dénormalisé si nécessaire
        // Pour l'instant, nous utilisons _count dans les requêtes
        // Pas d'action nécessaire car on utilise _count dynamiquement
      },
      'updating items count',
      { walletListId }
    );
  }
}
