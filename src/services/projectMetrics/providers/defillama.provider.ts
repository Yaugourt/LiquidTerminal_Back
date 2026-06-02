import { BaseApiService, HttpApiError } from '../../../core/base.api.service';
import {
  MetricProvider,
  NormalizedMetrics,
  DataSourceType,
  SeriesPoint,
} from '../../../types/projectMetrics.types';
import { logDeduplicator } from '../../../utils/logDeduplicator';

/** Minimal shapes we read from DeFiLlama responses. */
interface LlamaTvlPoint {
  date: number; // epoch seconds
  totalLiquidityUSD: number;
}
interface LlamaProtocolResponse {
  tvl?: LlamaTvlPoint[];
}
interface LlamaSummaryResponse {
  total24h?: number;
  totalDataChart?: Array<[number, number]>; // [epochSeconds, value]
}

/**
 * Provider for protocols listed on DeFiLlama. `identifier` is the protocol slug
 * (e.g. "hyperliquid"). Each sub-request is isolated: a 404 on fees does not
 * prevent TVL from being returned. DeFiLlama exposes historical series for free,
 * so we surface them without storing anything (live-first).
 */
export class DefiLlamaProvider extends BaseApiService implements MetricProvider {
  readonly type: DataSourceType = 'DEFILLAMA';

  constructor() {
    super('https://api.llama.fi');
  }

  async fetch(identifier: string): Promise<Partial<NormalizedMetrics>> {
    const slug = encodeURIComponent(identifier);
    const asOf = Date.now();
    const metrics: Partial<NormalizedMetrics> = {};
    const series: NonNullable<NormalizedMetrics['series']> = {};

    // --- TVL (+ historical series) ---
    try {
      const protocol = await this.get<LlamaProtocolResponse>(`/protocol/${slug}`);
      const tvlPoints = Array.isArray(protocol?.tvl) ? protocol.tvl : [];
      if (tvlPoints.length > 0) {
        const last = tvlPoints[tvlPoints.length - 1];
        metrics.tvl = { value: last.totalLiquidityUSD, source: this.type, unit: 'USD', asOf };
        series.tvl = tvlPoints.map<SeriesPoint>((p) => ({ t: p.date * 1000, v: p.totalLiquidityUSD }));
      }
    } catch (error) {
      this.logSubError('tvl', identifier, error);
    }

    // --- Fees (+ historical series) ---
    try {
      const fees = await this.get<LlamaSummaryResponse>(`/summary/fees/${slug}`);
      if (typeof fees?.total24h === 'number') {
        metrics.fees24h = { value: fees.total24h, source: this.type, unit: 'USD', asOf };
      }
      if (Array.isArray(fees?.totalDataChart)) {
        series.fees = fees.totalDataChart.map<SeriesPoint>(([t, v]) => ({ t: t * 1000, v }));
      }
    } catch (error) {
      this.logSubError('fees', identifier, error);
    }

    // --- Revenue (same endpoint, revenue dataType) ---
    try {
      const revenue = await this.get<LlamaSummaryResponse>(`/summary/fees/${slug}?dataType=dailyRevenue`);
      if (typeof revenue?.total24h === 'number') {
        metrics.revenue24h = { value: revenue.total24h, source: this.type, unit: 'USD', asOf };
      }
    } catch (error) {
      this.logSubError('revenue', identifier, error);
    }

    // --- DEX volume (+ historical series) ---
    try {
      const dex = await this.get<LlamaSummaryResponse>(`/summary/dexs/${slug}`);
      if (typeof dex?.total24h === 'number') {
        metrics.volume24h = { value: dex.total24h, source: this.type, unit: 'USD', asOf };
      }
      if (Array.isArray(dex?.totalDataChart)) {
        series.volume = dex.totalDataChart.map<SeriesPoint>(([t, v]) => ({ t: t * 1000, v }));
      }
    } catch (error) {
      this.logSubError('volume', identifier, error);
    }

    if (series.tvl || series.fees || series.volume) {
      metrics.series = series;
    }

    return metrics;
  }

  /** 404 means "this protocol does not expose that metric" — log at debug, not error. */
  private logSubError(metric: string, identifier: string, error: unknown): void {
    const is404 = error instanceof HttpApiError && error.statusCode === 404;
    const payload = { metric, identifier, error: error instanceof Error ? error.message : String(error) };
    if (is404) {
      logDeduplicator.info('DeFiLlama metric not available', payload);
    } else {
      logDeduplicator.warn('DeFiLlama metric fetch failed', payload);
    }
  }
}
