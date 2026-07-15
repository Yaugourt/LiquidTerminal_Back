import { PerpMarketData, PerpMarketQueryParams } from '../../types/market.types';
import { PaginatedResponse } from '../../types/common.types';
import { redisService } from '../../core/redis.service';
import { PerpMarketDataError } from '../../errors/perp.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class PerpAssetContextService {
  private static instance: PerpAssetContextService; // Ajout pour Singleton

  private readonly UPDATE_CHANNEL = 'perp:data:updated';
  private readonly MARKET_CACHE_KEY = 'perp:markets';
  private lastUpdate: Record<string, number> = {};

  // Le constructeur devient privé
  private constructor() {
    this.setupSubscriptions();
  }

  // Méthode statique pour récupérer l'instance unique
  public static getInstance(): PerpAssetContextService {
    if (!PerpAssetContextService.instance) {
      PerpAssetContextService.instance = new PerpAssetContextService();
    }
    return PerpAssetContextService.instance;
  }

  private setupSubscriptions(): void {
    redisService.subscribe(this.UPDATE_CHANNEL, async (message) => {
      try {
        const { type, marketName, timestamp } = JSON.parse(message);
        if (type === 'DATA_UPDATED') {
          this.lastUpdate[marketName] = timestamp;
          logDeduplicator.info('Perp market data cache updated', { 
            marketName, 
            timestamp 
          });
        }
      } catch (error) {
        logDeduplicator.error('Error processing cache update:', { 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    });
  }

  /**
   * Récupère les données des marchés perpétuels depuis le cache
   */
  public async getPerpMarketsData(params: PerpMarketQueryParams = {}): Promise<PaginatedResponse<PerpMarketData>> {
    try {
      const raw = await redisService.get(this.MARKET_CACHE_KEY);
      if (!raw) {
        throw new PerpMarketDataError('No perp market data available');
      }
      
      let markets = JSON.parse(raw) as PerpMarketData[];

      // Convertir l'openInterest en dollars pour tous les marchés
      markets = markets.map(market => ({
        ...market,
        openInterest: market.openInterest * market.price
      }));

      // Appliquer les filtres
      if (params.token) {
        markets = markets.filter(market => 
          market.name.toLowerCase().includes(params.token!.toLowerCase())
        );
      }
      if (params.pair) {
        markets = markets.filter(market => 
          market.name.toLowerCase().includes(params.pair!.toLowerCase())
        );
      }

      // Appliquer le tri
      const sortBy = params.sortBy || 'volume';
      const sortOrder = params.sortOrder || 'desc';
      
      markets.sort((a, b) => {
        const multiplier = sortOrder === 'desc' ? -1 : 1;
        
        // openInterest is already USD-converted above; the generic numeric
        // path below sorts it correctly (re-multiplying by price here used
        // to produce a non-monotonic order).
        const valueA = a[sortBy as keyof PerpMarketData];
        const valueB = b[sortBy as keyof PerpMarketData];
        
        if (valueA === undefined || valueA === null) return 1;
        if (valueB === undefined || valueB === null) return -1;
        
        if (typeof valueA === 'number' && typeof valueB === 'number') {
          return multiplier * (valueA - valueB);
        }
        
        return multiplier * String(valueA).localeCompare(String(valueB));
      });

      // Appliquer la pagination
      const limit = params.limit || 20;
      const page = params.page || 1;
      const start = (page - 1) * limit;
      const end = start + limit;
      const paginatedMarkets = markets.slice(start, end);

      // Calculer le volume total
      const totalVolume = markets.reduce((sum, market) => sum + (market.volume || 0), 0);

      logDeduplicator.info('Perp market data retrieved successfully', { 
        count: paginatedMarkets.length,
        total: markets.length,
        totalVolume,
        page,
        limit,
        sortBy,
        sortOrder
      });

      return {
        data: paginatedMarkets,
        pagination: {
          total: markets.length,
          page,
          limit,
          totalPages: Math.ceil(markets.length / limit),
          hasNext: page < Math.ceil(markets.length / limit),
          hasPrevious: page > 1
        },
        metadata: {
          totalVolume
        }
      };
    } catch (error) {
      logDeduplicator.error('Error retrieving perp market data:', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }
} 