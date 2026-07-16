import { DefiLlamaClient, DefiLlamaFeesDataType } from '../../clients/defillama/defillama.client';
import { DefiLlamaCoinsClient } from '../../clients/defillama/defillama-coins.client';
import { cacheService } from '../../core/cache.service';
import { DEFILLAMA_CACHE_KEYS, DEFILLAMA_TTL } from '../../constants/defillama.cache';
import {
  DefiLlamaChain,
  DefiLlamaMoneyBlock,
  DefiLlamaPrices,
  DefiLlamaProjectOverview,
  DefiLlamaProtocolDetail,
  DefiLlamaProtocolListItem,
  DefiLlamaSummary,
} from '../../types/defillama.types';

/** Extract the compact fees/volume block shared by the aggregate overview. */
function toMoneyBlock(summary: DefiLlamaSummary): DefiLlamaMoneyBlock {
  return {
    total24h: summary.total24h ?? null,
    total7d: summary.total7d ?? null,
    total30d: summary.total30d ?? null,
    totalAllTime: summary.totalAllTime ?? null,
    change_1d: summary.change_1d ?? null,
  };
}

/**
 * Thin service over the two DefiLlama clients. Every read is Redis-cached so the
 * free upstream is hit at most once per TTL regardless of project-page traffic.
 */
export class DefiLlamaService {
  private static instance: DefiLlamaService;
  private readonly client = DefiLlamaClient.getInstance();
  private readonly coinsClient = DefiLlamaCoinsClient.getInstance();

  public static getInstance(): DefiLlamaService {
    if (!DefiLlamaService.instance) {
      DefiLlamaService.instance = new DefiLlamaService();
    }
    return DefiLlamaService.instance;
  }

  public getProtocols(): Promise<DefiLlamaProtocolListItem[]> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.protocols,
      () => this.client.getProtocols(),
      DEFILLAMA_TTL.protocols
    );
  }

  public getChains(): Promise<DefiLlamaChain[]> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.chains,
      () => this.client.getChains(),
      DEFILLAMA_TTL.chains
    );
  }

  public getProtocol(slug: string): Promise<DefiLlamaProtocolDetail> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.protocol(slug),
      () => this.client.getProtocol(slug),
      DEFILLAMA_TTL.protocol
    );
  }

  public getProtocolTvl(slug: string): Promise<number> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.tvl(slug),
      () => this.client.getProtocolTvl(slug),
      DEFILLAMA_TTL.tvl
    );
  }

  public getDexSummary(slug: string): Promise<DefiLlamaSummary> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.dexs(slug),
      () => this.client.getDexSummary(slug),
      DEFILLAMA_TTL.dexs
    );
  }

  public getFeesSummary(
    slug: string,
    dataType: DefiLlamaFeesDataType = 'dailyFees'
  ): Promise<DefiLlamaSummary> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.fees(slug, dataType),
      () => this.client.getFeesSummary(slug, dataType),
      DEFILLAMA_TTL.fees
    );
  }

  public getPrices(coins: string): Promise<DefiLlamaPrices> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.prices(coins),
      () => this.coinsClient.getCurrentPrices(coins),
      DEFILLAMA_TTL.prices
    );
  }

  /**
   * Aggregated snapshot for one project page: TVL + market cap from the protocol
   * detail, plus DEX volume, fees, revenue and token price when the protocol has
   * those modules. The protocol detail is mandatory (a missing slug is a 404);
   * every other source is best-effort and resolves to `null` when unavailable,
   * so a lending market with no DEX module still returns a usable overview.
   */
  public getProjectOverview(slug: string): Promise<DefiLlamaProjectOverview> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.overview(slug),
      () => this.buildProjectOverview(slug),
      DEFILLAMA_TTL.overview
    );
  }

  private async buildProjectOverview(slug: string): Promise<DefiLlamaProjectOverview> {
    // The detail call is authoritative: if the slug is unknown, fail with 404.
    const detail = await this.client.getProtocol(slug);

    const [dexResult, feesResult, revenueResult] = await Promise.allSettled([
      this.client.getDexSummary(slug),
      this.client.getFeesSummary(slug, 'dailyFees'),
      this.client.getFeesSummary(slug, 'dailyRevenue'),
    ]);

    // Price needs a coin id; the protocol detail carries the CoinGecko id.
    let price: DefiLlamaProjectOverview['price'] = null;
    if (detail.gecko_id) {
      const coinKey = `coingecko:${detail.gecko_id}`;
      const priceResult = await Promise.allSettled([this.coinsClient.getCurrentPrices(coinKey)]);
      if (priceResult[0].status === 'fulfilled') {
        price = priceResult[0].value.coins[coinKey] ?? null;
      }
    }

    const volume = dexResult.status === 'fulfilled' ? toMoneyBlock(dexResult.value) : null;
    const fees = feesResult.status === 'fulfilled' ? toMoneyBlock(feesResult.value) : null;
    const revenue = revenueResult.status === 'fulfilled' ? toMoneyBlock(revenueResult.value) : null;

    return {
      slug,
      name: detail.name,
      logo: detail.logo ?? null,
      category: detail.category ?? null,
      chains: detail.chains ?? [],
      gecko_id: detail.gecko_id ?? null,
      tvl: this.sumCurrentTvl(detail),
      mcap: detail.mcap ?? null,
      currentChainTvls: detail.currentChainTvls ?? null,
      price,
      volume,
      fees,
      revenue,
    };
  }

  /** Sum the per-chain current TVL map into a single figure. */
  private sumCurrentTvl(detail: DefiLlamaProtocolDetail): number | null {
    const map = detail.currentChainTvls;
    if (!map || typeof map !== 'object') return null;
    const values = Object.values(map).filter((v): v is number => typeof v === 'number');
    if (values.length === 0) return null;
    return values.reduce((acc, v) => acc + v, 0);
  }
}
