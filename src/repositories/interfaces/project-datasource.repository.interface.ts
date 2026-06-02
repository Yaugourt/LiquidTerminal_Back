import { ProjectDataSourceRecord } from '../../types/projectMetrics.types';

export interface ProjectDataSourceCreateInput {
  projectId: number;
  type: string;
  identifier: string;
  config?: unknown;
  priority?: number;
  enabled?: boolean;
}

export interface ProjectDataSourceRepository {
  /** All data sources attached to a project, newest priority first. */
  findByProjectId(projectId: number): Promise<ProjectDataSourceRecord[]>;
  /** Only enabled data sources for a project. */
  findEnabledByProjectId(projectId: number): Promise<ProjectDataSourceRecord[]>;
  create(data: ProjectDataSourceCreateInput): Promise<ProjectDataSourceRecord>;
  delete(id: number): Promise<void>;
}
