import { BaseApiService } from '../../../core/base.api.service';
import { VaultData } from '../../../types/vault.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { redisService } from '../../../core/redis.service';

export class HyperliquidVaultsClient extends BaseApiService {
  private static instance: HyperliquidVaultsClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_STATS_URL || 'https://stats-data.hyperliquid.xyz/Mainnet') + '/vaults';
  private static readonly REQUEST_WEIGHT = 20;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;
  private static readonly FILTERED_CACHE_KEY = 'vaults:filtered_list';
  // Same list but WITHOUT the isClosed exclusion — used to serve the
  // opt-in `includeClosed` view. The default key above stays open-only so
  // every existing consumer (TVL aggregations…) is unaffected.
  private static readonly ALL_CACHE_KEY = 'vaults:filtered_list_all';
  private static readonly UPDATE_CHANNEL = 'vaults:list:updated';
  private static readonly UPDATE_INTERVAL = 30000; // 30 seconds

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HyperliquidVaultsClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('vaults');
    this.rateLimiter = RateLimiterService.getInstance('vaults', {
      maxWeightPerMinute: HyperliquidVaultsClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidVaultsClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidVaultsClient {
    if (!HyperliquidVaultsClient.instance) {
      HyperliquidVaultsClient.instance = new HyperliquidVaultsClient();
    }
    return HyperliquidVaultsClient.instance;
  }

  /**
   * Supprime les doublons et filtre les vaults invalides.
   * @param includeClosed Quand true, conserve les vaults fermés (la vue
   *        opt-in `includeClosed`). Par défaut ils sont exclus, comportement
   *        historique attendu par toutes les agrégations TVL existantes.
   */
  private processVaults(vaults: VaultData[], includeClosed = false): VaultData[] {
    // Identifier d'abord tous les vaults parents
    const parentVaults = new Set<string>();
    const seen = new Set<string>();

    // Première passe : identifier les parents et dédupliquer
    const uniqueVaults = vaults.filter(vault => {
      const key = `${vault.summary.name}:${vault.summary.leader}:${vault.summary.vaultAddress}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);

      // Si c'est un parent, on l'ajoute à la liste des parents
      if (vault.summary.relationship?.type === 'parent') {
        parentVaults.add(vault.summary.vaultAddress);
      }
      return true;
    });

    // Deuxième passe : filtrer et calculer la TVL
    const filteredVaults = uniqueVaults.filter(vault => {
      const { isClosed, relationship, tvl } = vault.summary;

      // Exclure les vaults fermés (sauf en mode includeClosed)
      if (isClosed && !includeClosed) {
        return false;
      }

      // Si c'est un enfant, on l'exclut systématiquement
      if (relationship?.type === 'child') {
        return false;
      }

      // Calculer la TVL pour les vaults valides
      const tvlValue = parseFloat(tvl);
      if (!tvl || isNaN(tvlValue) || !isFinite(tvlValue) || tvlValue < 0) {
        return false;
      }

      return true;
    });

    logDeduplicator.info('Vaults processing completed', {
      originalCount: vaults.length,
      uniqueCount: uniqueVaults.length,
      filteredCount: filteredVaults.length,
      parentVaultsCount: parentVaults.size,
      includeClosed
    });

    return filteredVaults;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Vaults polling already started');
      return;
    }

    logDeduplicator.info('Starting vaults polling');
    // Faire une première mise à jour immédiate
    this.updateVaultsList().catch(error => {
      logDeduplicator.error('Error in initial vaults update:', { error: error instanceof Error ? error.message : String(error) });
    });

    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateVaultsList().catch(error => {
        logDeduplicator.error('Error in vaults polling:', { error: error instanceof Error ? error.message : String(error) });
      });
    }, HyperliquidVaultsClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Vaults polling stopped');
    }
  }

  /**
   * Récupère la liste des vaults depuis l'API
   */
  private async getVaultsListRaw(): Promise<VaultData[]> {
    return this.circuitBreaker.execute(() => 
      this.get<VaultData[]>('')
    );
  }

  /**
   * Récupère la liste des vaults depuis le cache ou l'API
   */
  public async getVaultsList(): Promise<VaultData[]> {
    try {
      const cachedData = await redisService.get(HyperliquidVaultsClient.FILTERED_CACHE_KEY);
      if (cachedData) {
        logDeduplicator.info('Retrieved vaults data from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cachedData);
      }

      logDeduplicator.warn('No vaults data in cache, forcing update');
      await this.updateVaultsList();
      const freshData = await redisService.get(HyperliquidVaultsClient.FILTERED_CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get vaults data after update');
      }
      return JSON.parse(freshData);
    } catch (error) {
      logDeduplicator.error('Error fetching vaults list:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Met à jour la liste des vaults dans le cache
   */
  private async updateVaultsList(): Promise<VaultData[]> {
    try {
      const rawVaults = await this.getVaultsListRaw();

      // Traiter et filtrer les vaults : open-only (défaut) + variante avec closed
      const vaults = this.processVaults(rawVaults);
      const vaultsWithClosed = this.processVaults(rawVaults, true);

      // Sauvegarder les deux listes
      await Promise.all([
        redisService.set(
          HyperliquidVaultsClient.FILTERED_CACHE_KEY,
          JSON.stringify(vaults)
        ),
        redisService.set(
          HyperliquidVaultsClient.ALL_CACHE_KEY,
          JSON.stringify(vaultsWithClosed)
        )
      ]);

      // Notifier les mises à jour
      const now = Date.now();
      await redisService.publish(HyperliquidVaultsClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));

      this.lastUpdate = now;

      logDeduplicator.info('Vaults list updated', {
        count: vaults.length,
        countWithClosed: vaultsWithClosed.length
      });

      return vaults;
    } catch (error) {
      logDeduplicator.error('Failed to update vaults list:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HyperliquidVaultsClient.REQUEST_WEIGHT;
  }
} 