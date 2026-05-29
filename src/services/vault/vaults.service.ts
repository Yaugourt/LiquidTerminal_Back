import { VaultData, VaultQueryParams, VaultsResponse } from '../../types/vault.types';
import { VaultsError } from '../../errors/vault.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';

export class VaultsService {
  private static instance: VaultsService;
  private readonly UPDATE_CHANNEL = 'vaults:list:updated';
  private readonly FILTERED_CACHE_KEY = 'vaults:filtered_list';
  // Variante incluant les vaults fermés (peuplée par le client de polling).
  private readonly ALL_CACHE_KEY = 'vaults:filtered_list_all';
  private lastUpdate: Record<string, number> = {};

  private constructor() {
    this.setupSubscriptions();
  }

  private setupSubscriptions(): void {
    redisService.subscribe(this.UPDATE_CHANNEL, async (message) => {
      try {
        const { type, timestamp, totalTvl } = JSON.parse(message);
        if (type === 'DATA_UPDATED') {
          this.lastUpdate['vaults'] = timestamp;
          logDeduplicator.info('Vaults cache updated', { timestamp, totalTvl });
        }
      } catch (error) {
        logDeduplicator.error('Error processing cache update:', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  public static getInstance(): VaultsService {
    if (!VaultsService.instance) {
      VaultsService.instance = new VaultsService();
    }
    return VaultsService.instance;
  }

  /**
   * Calcule la TVL totale à partir des vaults
   */
  private calculateTotalTVL(vaults: VaultData[]): number {
    return vaults.reduce((total, vault) => {
      const tvl = parseFloat(vault.summary.tvl || '0');
      return total + (isNaN(tvl) ? 0 : tvl);
    }, 0);
  }

  /**
   * Récupère la liste des vaults avec filtrage, tri et pagination
   */
  public async getVaultsList(params: VaultQueryParams = {}): Promise<VaultsResponse> {
    try {
      // Opt-in : la vue includeClosed lit le cache qui retient les vaults
      // fermés. Par défaut on garde le cache open-only (comportement inchangé
      // pour toutes les agrégations TVL existantes).
      const cacheKey = params.includeClosed ? this.ALL_CACHE_KEY : this.FILTERED_CACHE_KEY;
      const cachedData = await redisService.get(cacheKey);
      if (!cachedData) {
        throw new VaultsError('No vaults data available in cache');
      }

      const vaults = JSON.parse(cachedData) as VaultData[];
      const totalTvl = this.calculateTotalTVL(vaults);

      // Appliquer les filtres de recherche
      let filteredVaults = [...vaults].map(vault => ({
        summary: vault.summary,
        apr: vault.apr
      }));

      // Filtre de statut : true = closed only, false = open only.
      // (Sans effet sur le cache open-only, qui ne contient pas de closed.)
      if (params.isClosed !== undefined) {
        filteredVaults = filteredVaults.filter(
          vault => vault.summary.isClosed === params.isClosed
        );
      }

      if (params.name) {
        filteredVaults = filteredVaults.filter(vault => 
          vault.summary.name.toLowerCase().includes(params.name!.toLowerCase())
        );
      }
      if (params.leader) {
        filteredVaults = filteredVaults.filter(vault => 
          vault.summary.leader.toLowerCase() === params.leader!.toLowerCase()
        );
      }

      // Appliquer le tri
      const sortBy = params.sortBy || 'tvl';
      const sortOrder = params.sortOrder || 'desc';
      
      filteredVaults.sort((a, b) => {
        const multiplier = sortOrder === 'desc' ? -1 : 1;
        
        switch (sortBy) {
          case 'apr':
            return multiplier * (a.apr - b.apr);
          case 'tvl': {
            const tvlA = parseFloat(a.summary.tvl);
            const tvlB = parseFloat(b.summary.tvl);
            if (isNaN(tvlA)) return 1;
            if (isNaN(tvlB)) return -1;
            return multiplier * (tvlA - tvlB);
          }
          case 'createTime':
            return multiplier * (a.summary.createTimeMillis - b.summary.createTimeMillis);
          default:
            return 0;
        }
      });

      // Appliquer la pagination
      const limit = params.limit || 20;
      const page = params.page || 1;
      const start = (page - 1) * limit;
      const end = start + limit;
      const paginatedVaults = filteredVaults.slice(start, end);

      logDeduplicator.info('Vaults list processed', { 
        count: paginatedVaults.length,
        total: filteredVaults.length,
        totalTvl,
        page,
        limit,
        lastUpdate: this.lastUpdate
      });

      return {
        success: true,
        data: paginatedVaults,
        pagination: {
          total: filteredVaults.length,
          page,
          limit,
          totalPages: Math.ceil(filteredVaults.length / limit),
          hasNext: page < Math.ceil(filteredVaults.length / limit),
          hasPrevious: page > 1,
          totalTvl,
          vaultsNumber: vaults.length
        }
      };
    } catch (error) {
      logDeduplicator.error('Error retrieving vaults list:', { error: error instanceof Error ? error.message : String(error) });
      throw error instanceof VaultsError ? error : new VaultsError('Failed to retrieve vaults list', 500);
    }
  }
} 