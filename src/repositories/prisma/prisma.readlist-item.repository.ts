import { PrismaClient } from '@prisma/client';
import { ReadListItemRepository } from '../interfaces/readlist-item.repository.interface';
import {
  ReadListItemResponse,
  ReadListItemCreateInput,
  ReadListItemUpdateInput
} from '../../types/readlist.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { prismaContent } from '../../core/prisma.content.service';
import { attachCreator } from '../../utils/cross-db-enrich';

export class PrismaReadListItemRepository extends BasePrismaRepository implements ReadListItemRepository {
  // ReadListItem stays on the Core DB; the related EducationalResource lives in Content,
  // so the cross-DB include is replaced by a manual fan-out fetch.
  /**
   * Attach the matching EducationalResource (with creator from Core) to each item
   * under the `resource` field expected by the frontend:
   *   item.resource = { id, url, createdAt, creator: { id, name, email } }.
   */
  private async attachResources<T extends { resourceId: number } & Record<string, unknown>>(
    items: T[]
  ): Promise<void> {
    if (items.length === 0) return;
    const resourceIds = Array.from(
      new Set(items.map((it) => it.resourceId).filter((id): id is number => typeof id === 'number'))
    );
    if (resourceIds.length === 0) return;

    const resources = await prismaContent.educationalResource.findMany({
      where: { id: { in: resourceIds } },
      select: { id: true, url: true, createdAt: true, addedBy: true }
    });
    const enriched = await attachCreator(
      resources as Array<Record<string, unknown>>,
      'addedBy'
    );
    const byId = new Map<number, Record<string, unknown>>();
    for (const r of enriched) {
      const row = r as unknown as Record<string, unknown> & { id: number };
      const { addedBy: _ignored, ...rest } = row as Record<string, unknown> & { addedBy?: unknown; id: number };
      byId.set(row.id, rest);
    }
    for (const item of items) {
      (item as Record<string, unknown>).resource = byId.get(item.resourceId) ?? null;
    }
  }

  private async attachResourceOne<T extends { resourceId: number } & Record<string, unknown>>(
    item: T | null
  ): Promise<T | null> {
    if (!item) return null;
    await this.attachResources([item]);
    return item;
  }

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
      // Note: filtering by resource.url is no longer possible at the Prisma layer
      // since EducationalResource lives in the Content DB. We restrict search to
      // local fields only; resource-URL search would require a two-step fetch.
      if (search) {
        where.notes = { contains: search, mode: 'insensitive' };
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
        orderBy
      });

      await this.attachResources(readListItems as Array<{ resourceId: number } & Record<string, unknown>>);

      return {
        data: readListItems as unknown as ReadListItemResponse[],
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all read list items', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, readListId: params.readListId, isRead: params.isRead });
  }

  async findById(id: number): Promise<ReadListItemResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const item = await this.prismaClient.readListItem.findUnique({
          where: { id }
        });
        const enriched = await this.attachResourceOne(
          item as ({ resourceId: number } & Record<string, unknown>) | null
        );
        return enriched as unknown as ReadListItemResponse | null;
      },
      'finding read list item by ID',
      { id }
    );
  }

  async create(data: ReadListItemCreateInput): Promise<ReadListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const item = await this.prismaClient.readListItem.create({
          data: {
            readList: {
              connect: { id: data.readListId }
            },
            // EducationalResource lives in Content DB but the Core schema still
            // declares the relation; we keep `connect` here. Read paths fetch
            // the resource explicitly from the Content client.
            resource: {
              connect: { id: data.resourceId }
            },
            notes: data.notes,
            order: data.order
          }
        });
        const enriched = await this.attachResourceOne(
          item as { resourceId: number } & Record<string, unknown>
        );
        return enriched as unknown as ReadListItemResponse;
      },
      'creating read list item',
      { readListId: data.readListId, resourceId: data.resourceId }
    );
  }

  async update(id: number, data: ReadListItemUpdateInput): Promise<ReadListItemResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const item = await this.prismaClient.readListItem.update({
          where: { id },
          data
        });
        const enriched = await this.attachResourceOne(
          item as { resourceId: number } & Record<string, unknown>
        );
        return enriched as unknown as ReadListItemResponse;
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
        const item = await this.prismaClient.readListItem.update({
          where: { id },
          data: { isRead }
        });
        const enriched = await this.attachResourceOne(
          item as { resourceId: number } & Record<string, unknown>
        );
        return enriched as unknown as ReadListItemResponse;
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