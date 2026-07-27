import { ReadListRepository } from '../interfaces/readlist.repository.interface';
import { 
  ReadListResponse, 
  ReadListCreateInput, 
  ReadListUpdateInput,
  ReadListSummaryResponse
} from '../../types/readlist.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { prismaContent } from '../../core/prisma.content.service';
import { attachCreator } from '../../utils/cross-db-enrich';

export class PrismaReadListRepository extends BasePrismaRepository implements ReadListRepository {
  // ReadList stays on the Core DB; only its items reference Content.educationalResource
  // (cross-DB), so we drop the nested `resource` include and fan out manually.
  private readonly includeConfig = {
    creator: {
      select: BasePrismaRepository.UserSelect
    },
    items: {
      orderBy: [
        { order: 'asc' as const },
        { addedAt: 'asc' as const }
      ]
    }
  };

  /**
   * After fetching a ReadList with `items` (each carrying `resourceId`),
   * batch-load the matching EducationalResource rows from the Content DB,
   * enrich them with their `creator` (Core DB), and attach to each item
   * under the `resource` field expected by the frontend:
   *   items[].resource = { id, url, createdAt, creator: { id, name, email } }.
   */
  private async attachResourcesToItems(
    items: Array<{ resourceId: number } & Record<string, unknown>>
  ): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) return;
    const resourceIds = Array.from(
      new Set(items.map((it) => it.resourceId).filter((id): id is number => typeof id === 'number'))
    );
    if (resourceIds.length === 0) return;

    const resources = await prismaContent.educationalResource.findMany({
      where: { id: { in: resourceIds } },
      select: {
        id: true,
        url: true,
        createdAt: true,
        addedBy: true,
        linkPreview: {
          select: { id: true, title: true, description: true, image: true, siteName: true, favicon: true }
        }
      }
    });
    const enrichedResources = await attachCreator(
      resources as Array<Record<string, unknown>>,
      'addedBy'
    );
    const byId = new Map<number, Record<string, unknown>>();
    for (const r of enrichedResources) {
      const row = r as unknown as Record<string, unknown> & { id: number };
      const { addedBy: _ignored, ...rest } = row as Record<string, unknown> & { addedBy?: unknown; id: number };
      byId.set(row.id, rest);
    }
    for (const item of items) {
      (item as Record<string, unknown>).resource = byId.get(item.resourceId) ?? null;
    }
  }

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

  /**
   * Attach `readCount` (items marked as read) to summary rows.
   * Prisma's `_count` cannot hold two differently-filtered counts of the same
   * relation, so the read counts come from one extra groupBy (never N+1).
   */
  private async attachReadCounts(
    readLists: Array<{ id: number } & Record<string, unknown>>
  ): Promise<void> {
    if (readLists.length === 0) return;
    const ids = readLists.map((l) => l.id);
    const grouped = await this.prismaClient.readListItem.groupBy({
      by: ['readListId'],
      where: { readListId: { in: ids }, isRead: true },
      _count: { _all: true }
    });
    const byId = new Map<number, number>(
      grouped.map((g: { readListId: number; _count: { _all: number } }) => [g.readListId, g._count._all])
    );
    for (const list of readLists) {
      (list as Record<string, unknown>).readCount = byId.get(list.id) ?? 0;
    }
  }

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
      await this.attachReadCounts(data);

      return {
        data,
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all read lists', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, userId: params.userId, isPublic: params.isPublic });
  }

  async findById(id: number): Promise<ReadListResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.findUnique({
          where: { id },
          include: this.includeConfig
        });
        if (!readList) return null;
        await this.attachResourcesToItems(
          (readList as { items?: Array<{ resourceId: number } & Record<string, unknown>> }).items ?? []
        );
        return readList as ReadListResponse;
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

        const summary = {
          ...readList,
          itemsCount: readList._count.items,
          readCount: 0, // overwritten by attachReadCounts below
          _count: undefined
        };
        await this.attachReadCounts([summary]);
        return summary;
      },
      'finding read list summary by ID',
      { id }
    );
  }

  async create(data: ReadListCreateInput): Promise<ReadListResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.create({
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
        await this.attachResourcesToItems(
          (readList as { items?: Array<{ resourceId: number } & Record<string, unknown>> }).items ?? []
        );
        return readList as ReadListResponse;
      },
      'creating read list',
      { name: data.name, userId: data.userId }
    );
  }

  async update(id: number, data: ReadListUpdateInput): Promise<ReadListResponse> {
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.update({
          where: { id },
          data,
          include: this.includeConfig
        });
        await this.attachResourcesToItems(
          (readList as { items?: Array<{ resourceId: number } & Record<string, unknown>> }).items ?? []
        );
        return readList as ReadListResponse;
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

        const summaries = readLists.map((readList: any) => ({
          ...readList,
          itemsCount: readList._count.items,
          _count: undefined
        }));
        await this.attachReadCounts(summaries);
        return summaries;
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

  /**
   * READ visibility: public lists are readable by anyone, private ones only by
   * their owner. MUST NOT be used to gate writes — see `isOwner`.
   */
  async hasAccess(readListId: number, userId: number | null): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.findUnique({
          where: { id: readListId },
          select: { userId: true, isPublic: true }
        });

        if (!readList) return false;
        return readList.isPublic || (userId !== null && readList.userId === userId);
      },
      'checking read list access',
      { readListId, userId }
    );
  }

  /**
   * WRITE authorization: true only for the list's owner. `isPublic` is
   * deliberately ignored — making a list public grants read visibility, never
   * the right for others to mutate or delete it.
   */
  async isOwner(readListId: number, userId: number | null): Promise<boolean> {
    if (userId === null) return false;
    return this.executeWithErrorHandling(
      async () => {
        const readList = await this.prismaClient.readList.findUnique({
          where: { id: readListId },
          select: { userId: true }
        });
        return readList !== null && readList.userId === userId;
      },
      'checking read list ownership',
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