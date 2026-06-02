import {
  ProjectDataSourceRepository,
  ProjectDataSourceCreateInput,
} from '../interfaces/project-datasource.repository.interface';
import { ProjectDataSourceRecord } from '../../types/projectMetrics.types';
import { BasePrismaRepository } from './base-prisma.repository';
import { prismaContent } from '../../core/prisma.content.service';

export class PrismaProjectDataSourceRepository
  extends BasePrismaRepository
  implements ProjectDataSourceRepository
{
  constructor() {
    super();
    // ProjectDataSource lives in the Content DB alongside Project.
    this.setPrismaClient(prismaContent as unknown as typeof this.prismaClient, true);
  }

  async findByProjectId(projectId: number): Promise<ProjectDataSourceRecord[]> {
    return this.executeWithErrorHandling(async () => {
      return this.prismaClient.projectDataSource.findMany({
        where: { projectId },
        orderBy: { priority: 'desc' },
      });
    }, 'finding project data sources');
  }

  async findEnabledByProjectId(projectId: number): Promise<ProjectDataSourceRecord[]> {
    return this.executeWithErrorHandling(async () => {
      return this.prismaClient.projectDataSource.findMany({
        where: { projectId, enabled: true },
        orderBy: { priority: 'desc' },
      });
    }, 'finding enabled project data sources');
  }

  async create(data: ProjectDataSourceCreateInput): Promise<ProjectDataSourceRecord> {
    return this.executeWithErrorHandling(async () => {
      const config =
        data.config == null
          ? null
          : typeof data.config === 'string'
            ? data.config
            : JSON.stringify(data.config);

      return this.prismaClient.projectDataSource.create({
        data: {
          projectId: data.projectId,
          type: data.type,
          identifier: data.identifier,
          config,
          priority: data.priority ?? 0,
          enabled: data.enabled ?? true,
        },
      });
    }, 'creating project data source');
  }

  async delete(id: number): Promise<void> {
    await this.executeWithErrorHandling(async () => {
      await this.prismaClient.projectDataSource.delete({ where: { id } });
    }, 'deleting project data source');
  }
}
