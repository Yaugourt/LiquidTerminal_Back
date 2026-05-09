import { Prisma } from '../../../prisma-content/generated/client';
import { ProjectRepository } from '../interfaces/project.repository.interface';
import { Project, ProjectCreateInput, ProjectUpdateInput } from '../../types/project.types';
import { BasePagination } from '../../types/common.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { prismaContent } from '../../core/prisma.content.service';

export class PrismaProjectRepository extends BasePrismaRepository implements ProjectRepository {
  constructor() {
    super();
    // Project lives in the Content DB after the multi-DB split.
    this.setPrismaClient(prismaContent as unknown as typeof this.prismaClient, true);
  }

  // Helper pour les includes répétitifs
  private readonly includeConfig = {
    categories: {
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    }
  } as const;

  async findAll(params: {
    page?: number;
    limit?: number;
    sort?: string;
    order?: 'asc' | 'desc';
    search?: string;
    categoryIds?: number[];
  }): Promise<{
    data: Project[];
    pagination: BasePagination;
  }> {
    return this.executeWithErrorHandling(async () => {
      const {
        page = 1,
        limit = 10,
        sort = 'createdAt',
        order = 'desc',
        search,
        categoryIds
      } = params;

      this.validatePaginationParams({ page, limit, sort, order });
      
      const where: any = {};
      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { desc: { contains: search, mode: 'insensitive' } }
        ];
      }
      if (categoryIds && categoryIds.length > 0) {
        where.categories = {
          some: {
            categoryId: {
              in: categoryIds
            }
          }
        };
      }
      
      const { skip, take, orderBy } = this.buildQueryParams({ page, limit, sort, order });

      const total = await this.prismaClient.project.count({ where });
      const projects = await this.prismaClient.project.findMany({
        where,
        skip,
        take,
        orderBy,
        include: this.includeConfig
      });

      // Transformer les données pour correspondre au type Project
      const transformedProjects = projects.map((project: any) => ({
        ...project,
        categories: project.categories.map((pc: any) => pc.category)
      }));

      return {
        data: transformedProjects,
        pagination: this.buildPagination(total, page, limit)
      };
    }, 'finding all projects', { page: params.page, limit: params.limit, sort: params.sort, order: params.order, search: params.search, categoryIds: params.categoryIds });
  }

  async findById(id: number): Promise<Project | null> {
    return this.executeWithErrorHandling(
      async () => {
        const project = await this.prismaClient.project.findUnique({
          where: { id },
          include: this.includeConfig
        });

        if (!project) return null;

        return {
          ...project,
          categories: project.categories.map((pc: any) => pc.category)
        };
      },
      'finding project by ID',
      { id }
    );
  }

  async create(data: ProjectCreateInput): Promise<Project> {
    return this.executeWithErrorHandling(
      async () => {
        const { categoryIds, ...projectData } = data;
        
        const createData: Prisma.ProjectCreateInput = {
          title: projectData.title,
          desc: projectData.desc,
          logo: projectData.logo ?? '',
          banner: projectData.banner,
          token: projectData.token,
          twitter: projectData.twitter,
          discord: projectData.discord,
          telegram: projectData.telegram,
          website: projectData.website,
          ...(categoryIds && categoryIds.length > 0 ? {
            categories: {
              create: categoryIds.map(categoryId => ({
                categoryId
              }))
            }
          } : {})
        };

        const project = await this.prismaClient.project.create({
          data: createData,
          include: this.includeConfig
        });

        return {
          ...project,
          categories: (project as typeof project & { categories: { category: unknown }[] }).categories.map((pc) => pc.category)
        } as Project;
      },
      'creating project',
      { title: data.title }
    );
  }

  async update(id: number, data: ProjectUpdateInput): Promise<Project> {
    return this.executeWithErrorHandling(
      async () => {
        const { categoryIds, ...projectData } = data;
        
        // Si categoryIds est fourni, on supprime les anciennes et on ajoute les nouvelles
        if (categoryIds !== undefined) {
          await this.prismaClient.projectCategory.deleteMany({
            where: { projectId: id }
          });
        }

        const project = await this.prismaClient.project.update({
          where: { id },
          data: {
            ...projectData,
            ...(categoryIds && categoryIds.length > 0 ? {
              categories: {
                create: categoryIds.map(categoryId => ({
                  categoryId
                }))
              }
            } : {})
          },
          include: this.includeConfig
        });

        return {
          ...project,
          categories: project.categories.map((pc: any) => pc.category)
        };
      },
      'updating project',
      { id, ...data }
    );
  }

  async delete(id: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.project.delete({
          where: { id }
        });
      },
      'deleting project',
      { id }
    );
  }

  async existsByTitle(title: string): Promise<boolean> {
    return this.executeWithErrorHandling(
      async () => {
        const project = await this.prismaClient.project.findFirst({
          where: { title }
        });
        return !!project;
      },
      'checking if project exists by title',
      { title }
    );
  }

  async findByCategory(categoryId: number): Promise<Project[]> {
    return this.executeWithErrorHandling(
      async () => {
        const projectCategories = await this.prismaClient.projectCategory.findMany({
          where: { categoryId },
          include: {
            project: {
              include: this.includeConfig
            }
          }
        });

        return projectCategories.map((pc: any) => ({
          ...pc.project,
          categories: pc.project.categories.map((cat: any) => cat.category)
        }));
      },
      'finding projects by category',
      { categoryId }
    );
  }

  async findByTitle(title: string): Promise<Project | null> {
    return this.executeWithErrorHandling(
      async () => {
        const project = await this.prismaClient.project.findFirst({
          where: { title },
          include: this.includeConfig
        });

        if (!project) return null;

        return {
          ...project,
          categories: project.categories.map((pc: any) => pc.category)
        };
      },
      'finding project by title',
      { title }
    );
  }

  async assignCategories(projectId: number, categoryIds: number[]): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.projectCategory.createMany({
          data: categoryIds.map(categoryId => ({
            projectId,
            categoryId
          })),
          skipDuplicates: true
        });
      },
      'assigning categories to project',
      { projectId, categoryIds }
    );
  }

  async removeCategories(projectId: number, categoryIds: number[]): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.projectCategory.deleteMany({
          where: {
            projectId,
            categoryId: {
              in: categoryIds
            }
          }
        });
      },
      'removing categories from project',
      { projectId, categoryIds }
    );
  }

  async getProjectCategories(projectId: number): Promise<any[]> {
    return this.executeWithErrorHandling(
      async () => {
        const projectCategories = await this.prismaClient.projectCategory.findMany({
          where: { projectId },
          include: {
            category: {
              select: {
                id: true,
                name: true,
                description: true,
                createdAt: true,
                updatedAt: true
              }
            }
          }
        });

        return projectCategories.map((pc: any) => pc.category);
      },
      'getting project categories',
      { projectId }
    );
  }
} 