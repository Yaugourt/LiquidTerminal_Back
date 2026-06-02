import { MetricProvider, NormalizedMetrics, DataSourceType } from '../../../types/projectMetrics.types';
import { SpotAssetContextService } from '../../spot/marketData.service';
import { MarketData } from '../../../types/market.types';
import { logDeduplicator } from '../../../utils/logDeduplicator';

/**
 * Provider for HIP-1 spot tokens. Reuses the already-cached HL spot market data
 * (no extra network call) and maps it to normalized metrics.
 *
 * `identifier` is the token symbol as it appears in `MarketData.name` (e.g. "HYPE").
 */
export class HlSpotTokenProvider implements MetricProvider {
  readonly type: DataSourceType = 'HL_SPOT_TOKEN';

  async fetch(identifier: string): Promise<Partial<NormalizedMetrics>> {
    const spotService = SpotAssetContextService.getInstance();

    // `token` filter is a substring match upstream — fetch candidates then match exactly.
    const result = await spotService.getMarketsData({ token: identifier, limit: 100 });
    const symbol = identifier.toLowerCase();
    const market: MarketData | undefined = result.data.find(
      (m) => m.name.toLowerCase() === symbol
    );

    if (!market) {
      logDeduplicator.warn('HL spot token not found for project metrics', { identifier });
      return {};
    }

    const asOf = Date.now();
    const metrics: Partial<NormalizedMetrics> = {};

    if (typeof market.price === 'number') {
      metrics.price = { value: market.price, source: this.type, unit: 'USD', asOf };
    }
    if (typeof market.marketCap === 'number') {
      metrics.marketCap = { value: market.marketCap, source: this.type, unit: 'USD', asOf };
    }
    if (typeof market.volume === 'number') {
      metrics.volume24h = { value: market.volume, source: this.type, unit: 'USD', asOf };
    }
    if (typeof market.change24h === 'number') {
      metrics.change24h = { value: market.change24h, source: this.type, unit: '%', asOf };
    }
    // Fully diluted valuation = price × total supply, when supply is known.
    if (typeof market.price === 'number' && typeof market.supply === 'number' && market.supply > 0) {
      metrics.fdv = { value: market.price * market.supply, source: this.type, unit: 'USD', asOf };
    }

    return metrics;
  }
}
