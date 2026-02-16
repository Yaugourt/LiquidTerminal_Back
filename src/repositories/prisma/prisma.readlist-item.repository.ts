import { PrismaClient } from '@prisma/client';
import { ReadListItemRepository } from '../interfaces/readlist-item.repository.interface';
import { 
  ReadListItemResponse, 
  ReadListItemCreateInput, 
  ReadListItemUpdateInput
} from '../../types/readlist.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';

export class PrismaReadListItemRepository extends BasePrismaRepository implements ReadListItemRepository {
  // Helper pour les includes répétitifs
  private readonly includeConfig = {
    resource: {
      include: {
        creator: {
          select: BasePrismaRepository.UserSelect
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
    readListId?: number;
    isRead?: boolean;
  }): Promise<{
    data: ReadListItemResponse[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 10,
        sort = 'addedAt',
        order = 'desc',
        search,
        readListId,
        isRead
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where: any = {};
      if (search) {
        where.OR = [
          { notes: { contains: search, mode: 'insensitive' } },
          { resource: { url: { contains: search, mode: 'insensitive' } } }
        ];
      }
      if (readListId !== undefined) {
        where.readListId = readListId;
      }
      if (isRead !== undefined) {
        where.isRead = isRead;
      }
      
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.readListItem.count({ where });
      const readListItems = await this.prismaClient.readListItem.findMany({
        where,
        skip,
        take,
        orderBy,
        include: this.includeConfig
      });

      return {
        data: readListItems,
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all read list items', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, readListId: params.readListId, isRead: params.isRead });
  }

  async findById(id: number): Promise<ReadListItemResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readListItem.findUnique({
          where: { id },
          include: this.includeConfig
        });
      },
      'finding read list item by ID',
      { id }
    );
  }

  async create(data: ReadListItemCreateInput): Promise<ReadListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readListItem.create({
          data: {
            readList: {
              connect: { id: data.readListId }
            },
            resource: {
              connect: { id: data.resourceId }
            },
            notes: data.notes,
            order: data.order
          },
          include: this.includeConfig
        });
      },
      'creating read list item',
      { readListId: data.readListId, resourceId: data.resourceId }
    );
  }

  async update(id: number, data: ReadListItemUpdateInput): Promise<ReadListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readListItem.update({
          where: { id },
          data,
          include: this.includeConfig
        });
      },
      'updating read list item',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.readListItem.delete({
          where: { id }
        });
      },
      'deleting read list item',
      { id }
    );
  }

  async existsByReadListAndResource(readListId: number, resourceId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const readListItem = await this.prismaClient.readListItem.findFirst({
          where: { readListId, resourceId }
        });
        return !!readListItem;
      },
      'checking if read list item exists by read list and resource',
      { readListId, resourceId }
    );
  }

  async findByReadList(readListId: number, params?: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    isRead?: boolean;
  }): Promise<{
    data: ReadListItemResponse[];
    pagination: BasePagination;
  }> {
    return this.findAll({ ...params, readListId });
  }

  async existsInReadList(readListId: number, resourceId: number): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const readListItem = await this.prismaClient.readListItem.findFirst({
          where: { readListId, resourceId }
        });
        return !!readListItem;
      },
      'checking if resource exists in read list',
      { readListId, resourceId }
    );
  }

  async toggleReadStatus(id: number, isRead: boolean): Promise<ReadListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readListItem.update({
          where: { id },
          data: { isRead },
          include: this.includeConfig
        });
      },
      'toggling read status',
      { id, isRead }
    );
  }

  async reorderItems(readListId: number, itemOrders: { id: number; order: number }[]): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        const client = this.prismaClient as PrismaClient;
        await client.$transaction(
          itemOrders.map(({ id, order }) =>
            client.readListItem.update({
              where: { id, readListId },
              data: { order }
            })
          )
        );
      },
      'reordering items',
      { readListId, itemsCount: itemOrders.length }
    );
  }

  async getNextOrder(readListId: number): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        const lastItem = await this.prismaClient.readListItem.findFirst({
          where: { readListId },
          orderBy: { order: 'desc' },
          select: { order: true }
        });
        
        return lastItem?.order !== null && lastItem?.order !== undefined 
          ? lastItem.order + 1 
          : 0;
      },
      'getting next order',
      { readListId }
    );
  }

  async deleteByReadList(readListId: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.readListItem.deleteMany({
          where: { readListId }
        });
      },
      'deleting all items from read list',
      { readListId }
    );
  }

  async countByReadList(readListId: number): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readListItem.count({
          where: { readListId }
        });
      },
      'counting items by read list',
      { readListId }
    );
  }

  async countByReadStatus(readListId: number, isRead: boolean): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        return await this.prismaClient.readListItem.count({
          where: { readListId, isRead }
        });
      },
      'counting items by read status',
      { readListId, isRead }
    );
  }
} 