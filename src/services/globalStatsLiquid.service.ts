import { DashboardGlobalStats } from '../types/market.types';
import { ValidatorSummary } from '../types/staking.types';
import { HyperliquidGlobalStatsClient } from '../clients/hyperliquid/globalstats.client';
import { BridgedUsdcService } from './bridgedUsdc.service';
import { ValidatorSummariesService } from './staking/validator.service';
import { VaultsService } from './vault/vaults.service';
import { logDeduplicator } from '../utils/logDeduplicator';


export class DashboardGlobalStatsService {
  private globalStatsClient: HyperliquidGlobalStatsClient;
  private bridgedUsdcService: BridgedUsdcService;
  private validatorSummariesService: ValidatorSummariesService;
  private vaultsService: VaultsService;
  private readonly HYPE_DECIMALS = 8;

  constructor() {
    this.globalStatsClient = HyperliquidGlobalStatsClient.getInstance();
    this.bridgedUsdcService = new BridgedUsdcService();
    this.validatorSummariesService = ValidatorSummariesService.getInstance();
    this.vaultsService = VaultsService.getInstance();
  }

  private formatHypeAmount(rawAmount: number): number {
    return Math.floor(rawAmount / Math.pow(10, this.HYPE_DECIMALS));
  }

  /**
   * Récupère les statistiques globales personnalisées pour la dashboard
   */
  public async getDashboardGlobalStats(): Promise<DashboardGlobalStats> {
    try {
      // Récupérer les données en parallèle
      // Bridged USDC comes from a shared 5 min cache of DefiLlama and never
      // throws: a DefiLlama outage leaves it null (or its last copy), not a 500.
      const [globalStats, bridgedUsdc, validatorSummaries, vaultsData] = await Promise.all([
        this.globalStatsClient.getGlobalStats(),
        this.bridgedUsdcService.getLatestBridgedUsdc(),
        this.validatorSummariesService.getValidatorSummaries(),
        this.vaultsService.getVaultsList()
      ]);

      // Calculer le total de HYPE staké
      const rawTotalHypeStake = validatorSummaries.reduce((total: number, validator: ValidatorSummary) => total + validator.stake, 0);
      const totalHypeStake = this.formatHypeAmount(rawTotalHypeStake);

      return {
        numberOfUsers: globalStats.nUsers,
        dailyVolume: globalStats.dailyVolume,
        bridgedUsdc,
        totalHypeStake: totalHypeStake,
        vaultsTvl: vaultsData.pagination.totalTvl
      };
    } catch (error) {
      logDeduplicator.error('Error fetching dashboard global stats:', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }
}
