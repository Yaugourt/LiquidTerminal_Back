import { MetricsSnapshotClient } from '../../clients/metrics/metrics-snapshot.client';
import { MetricHistoryPoint, MetricKey } from '../../types/metrics-history.types';

/**
 * Thin service over the metrics snapshot poller: serves the stored hourly
 * history of a self-sampled metric. All sampling and persistence live in the
 * client; this just wraps a read in the standard response envelope.
 */
export class MetricsHistoryService {
  private static instance: MetricsHistoryService;
  private readonly client: MetricsSnapshotClient;

  private constructor() {
    this.client = MetricsSnapshotClient.getInstance();
  }

  public static getInstance(): MetricsHistoryService {
    if (!MetricsHistoryService.instance) {
      MetricsHistoryService.instance = new MetricsHistoryService();
    }
    return MetricsHistoryService.instance;
  }

  /** Stored history for `metric` over the last `hours` (empty until migrated). */
  public async getHistory(
    metric: MetricKey,
    hours: number
  ): Promise<{ success: true; data: MetricHistoryPoint[] }> {
    const data = await this.client.getHistory(metric, hours);
    return { success: true, data };
  }
}
