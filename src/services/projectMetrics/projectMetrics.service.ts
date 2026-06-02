import {
  MetricProvider,
  NormalizedMetrics,
  DataSourceType,
  ProjectMetricsResponse,
  ProjectDataSourceRecord,
} from '../../types/projectMetrics.types';
import { projectRepository, projectDataSourceRepository } from '../../repositories';
import { cacheService } from '../../core/cache.service';
import { CACHE_KEYS, CACHE_TTL } from '../../constants/cache.constants';
import { ProjectNotFoundError } from '../../errors/project.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HlSpotTokenProvider } from './providers/hlSpotToken.provider';
import { DefiLlamaProvider } from './providers/defillama.provider';

/** Metric keys merged by priority (everything on NormalizedMetrics except `series`). */
const METRIC_KEYS = [
  'tvl', 'volume24h', 'fees24h', 'revenue24h',
  'price', 'marketCap', 'fdv', 'change24h', 'holders',
] as const;

/**
 * Aggregates normalized metrics for a project from its attached data sources.
 *
 * Provider registry is the single extension point: adding a new source =
 * register one provider here. Sources run in parallel; one failing provider
 * never breaks the response. Same metric from multiple sources → highest
 * `priority` wins.
 */
export class ProjectMetricsService {
  private static instance: ProjectMetricsService;

  private readonly registry: Partial<Record<DataSourceType, MetricProvider>>;

  private constructor() {
    this.registry = {
      HL_SPOT_TOKEN: new HlSpotTokenProvider(),
      DEFILLAMA: new DefiLlamaProvider(),
    };
  }

  public static getInstance(): ProjectMetricsService {
    if (!ProjectMetricsService.instance) {
      ProjectMetricsService.instance = new ProjectMetricsService();
    }
    return ProjectMetricsService.instance;
  }

  public async getMetrics(projectId: number): Promise<ProjectMetricsResponse> {
    return cacheService.getOrSet(
      CACHE_KEYS.PROJECT_METRICS(projectId),
      () => this.computeMetrics(projectId),
      CACHE_TTL.MEDIUM
    );
  }

  private async computeMetrics(projectId: number): Promise<ProjectMetricsResponse> {
    const project = await projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError();
    }

    const sources = await this.resolveSources(projectId, project.token ?? null);

    // Run each source's provider in parallel; isolate failures.
    const settled = await Promise.allSettled(
      sources.map(async (src) => {
        const provider = this.registry[src.type as DataSourceType];
        if (!provider) {
          logDeduplicator.warn('No provider registered for data source type', { type: src.type });
          return { src, metrics: {} as Partial<NormalizedMetrics> };
        }
        const metrics = await provider.fetch(src.identifier, src.config ?? undefined);
        return { src, metrics };
      })
    );

    const contributions = settled
      .map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        logDeduplicator.warn('Project metric provider failed', {
          projectId,
          type: sources[i]?.type,
          identifier: sources[i]?.identifier,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
        return null;
      })
      .filter((c): c is { src: ProjectDataSourceRecord; metrics: Partial<NormalizedMetrics> } => c !== null);

    const { metrics, contributingTypes } = this.merge(contributions);

    return {
      projectId,
      metrics,
      sources: contributingTypes,
      updatedAt: Date.now(),
    };
  }

  /**
   * Hybrid mapping: explicit enabled data sources + an auto-derived HL_SPOT_TOKEN
   * from the project's `token` field when no explicit spot source exists.
   */
  private async resolveSources(
    projectId: number,
    token: string | null
  ): Promise<ProjectDataSourceRecord[]> {
    const explicit = await projectDataSourceRepository.findEnabledByProjectId(projectId);

    const hasSpotSource = explicit.some((s) => s.type === 'HL_SPOT_TOKEN');
    if (token && token.trim() && !hasSpotSource) {
      explicit.push({
        id: -1,
        projectId,
        type: 'HL_SPOT_TOKEN',
        identifier: token.trim(),
        config: null,
        priority: 0,
        enabled: true,
      });
    }

    // Highest priority first so it wins during merge.
    return explicit.sort((a, b) => b.priority - a.priority);
  }

  /** First (highest-priority) source to provide a metric key wins. */
  private merge(
    contributions: Array<{ src: ProjectDataSourceRecord; metrics: Partial<NormalizedMetrics> }>
  ): { metrics: NormalizedMetrics; contributingTypes: DataSourceType[] } {
    const metrics: NormalizedMetrics = {};
    const contributingTypes = new Set<DataSourceType>();

    for (const { src, metrics: m } of contributions) {
      let contributed = false;

      for (const key of METRIC_KEYS) {
        if (m[key] !== undefined && metrics[key] === undefined) {
          metrics[key] = m[key];
          contributed = true;
        }
      }

      if (m.series) {
        const series = metrics.series ?? {};
        for (const k of ['tvl', 'fees', 'volume'] as const) {
          if (m.series[k] && !series[k]) {
            series[k] = m.series[k];
            contributed = true;
          }
        }
        metrics.series = series;
      }

      if (contributed) {
        contributingTypes.add(src.type as DataSourceType);
      }
    }

    return { metrics, contributingTypes: Array.from(contributingTypes) };
  }
}
