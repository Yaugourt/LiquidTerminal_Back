import { PrismaClient } from '@prisma/client';
import { WalletListItemRepository } from '../interfaces/walletlist-item.repository.interface';
import { 
  WalletListItemResponse, 
  WalletListItemCreateInput, 
  WalletListItemUpdateInput
} from '../../types/walletlist.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';

export class PrismaWalletListItemRepository extends BasePrismaRepository implements WalletListItemRepository {
  // Helper pour les includes répétitifs
  private readonly includeConfig = {
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
  };

  async findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    walletListId?: number;
  }): Promise<{
    data: WalletListItemResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 10,
        sort = 'addedAt',
        order = 'desc',
        search,
        walletListId
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where: any = {};
      if (search) {
        where.OR = [
          { notes: { contains: search, mode: 'insensitive' } },
          { userWallet: { 
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { Wallet: { address: { contains: search, mode: 'insensitive' } } }
            ]
          }}
        ];
      }
      if (walletListId !== undefined) {
        where.walletListId = walletListId;
      }
      
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.walletListItem.count({ where });
      const walletListItems = await this.prismaClient.walletListItem.findMany({
        where,
        skip,
        take,
        orderBy,
        include: this.includeConfig
      });

      return {
        data: walletListItems,
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all wallet list items', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, walletListId: params.walletListId });
  }

  async findById(id: number): Promise<WalletListItemResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletListItem.findUnique({
          where: { id },
          include: this.includeConfig
        });
      },
      'finding wallet list item by ID',
      { id }
    );
  }

  async create(data: WalletListItemCreateInput): Promise<WalletListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletListItem.create({
          data: {
            walletList: {
              connect: { id: data.walletListId }
            },
            userWallet: {
              connect: { id: data.userWalletId }
            },
            notes: data.notes,
            order: data.order
          },
          include: this.includeConfig
        });
      },
      'creating wallet list item',
      { walletListId: data.walletListId, userWalletId: data.userWalletId }
    );
  }

  async update(id: number, data: WalletListItemUpdateInput): Promise<WalletListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletListItem.update({
          where: { id },
          data,
          include: this.includeConfig
        });
      },
      'updating wallet list item',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.walletListItem.delete({
          where: { id }
        });
      },
      'deleting wallet list item',
      { id }
    );
  }

  async findByWalletList(walletListId: number, params?: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
  }): Promise<{
    data: WalletListItemResponse[];
    pagination: BasePagination;
  }> {
    return this.findAll({ ...params, walletListId });
  }

  async existsInWalletList(walletListId: number, userWalletId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const walletListItem = await this.prismaClient.walletListItem.findFirst({
          where: { walletListId, userWalletId }
        });
        return !!walletListItem;
      },
      'checking if userWallet exists in wallet list',
      { walletListId, userWalletId }
    );
  }

  async reorderItems(walletListId: number, itemOrders: { id: number; order: number }[]): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        const client = this.prismaClient as PrismaClient;
        await client.$transaction(
          itemOrders.map(({ id, order }) =>
            client.walletListItem.update({
              where: { id, walletListId },
              data: { order }
            })
          )
        );
      },
      'reordering items',
      { walletListId, itemsCount: itemOrders.length }
    );
  }

  async getNextOrder(walletListId: number): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        const lastItem = await this.prismaClient.walletListItem.findFirst({
          where: { walletListId },
          orderBy: { order: 'desc' },
          select: { order: true }
        });
        
        return lastItem?.order !== null && lastItem?.order !== undefined 
          ? lastItem.order + 1 
          : 0;
      },
      'getting next order',
      { walletListId }
    );
  }

  async deleteByWalletList(walletListId: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.walletListItem.deleteMany({
          where: { walletListId }
        });
      },
      'deleting all items from wallet list',
      { walletListId }
    );
  }

  async countByWalletList(walletListId: number): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletListItem.count({
          where: { walletListId }
        });
      },
      'counting items by wallet list',
      { walletListId }
    );
  }

  async updateOrder(id: number, order: number): Promise<WalletListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.walletListItem.update({
          where: { id },
          data: { order },
          include: this.includeConfig
        });
      },
      'updating wallet list item order',
      { id, order }
    );
  }

  async bulkCreate(data: Array<{ walletListId: number; userWalletId: number; order?: number }>): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.walletListItem.createMany({
          data,
          skipDuplicates: true
        });
      },
      'bulk creating wallet list items',
      { count: data.length }
    );
  }
}
