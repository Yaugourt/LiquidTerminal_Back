import { DashboardGlobalStats } from '../types/market.types';
import { ValidatorSummary } from '../types/staking.types';
import { HyperliquidGlobalStatsClient } from '../clients/hyperliquid/globalstats.client';
import { BridgedUsdcService } from './bridgedUsdc.service';
import { ValidatorSummariesService } from './staking/validator.service';
import { VaultsService } from './vault/vaults.service';
import { logDeduplicator } from '../utils/logDeduplicator';

/** The fields read from the pollers' caches (bridged USDC keeps its own copy). */
type PolledField = 'numberOfUsers' | 'dailyVolume' | 'totalHypeStake' | 'vaultsTvl';

/** How long a field may answer its last value while its source fails. */
export const GLOBAL_STATS_LAST_GOOD_MAX_AGE_MS = 10 * 60_000;

export class DashboardGlobalStatsService {
  private globalStatsClient: HyperliquidGlobalStatsClient;
  private bridgedUsdcService: BridgedUsdcService;
  private validatorSummariesService: ValidatorSummariesService;
  private vaultsService: VaultsService;
  private readonly HYPE_DECIMALS = 8;
  /**
   * Last value of each polled field, and when it was read. A source that
   * fails (its Redis key evicted, Hyperliquid down past the 5 min cache)
   * answers its last value for GLOBAL_STATS_LAST_GOOD_MAX_AGE_MS, then null.
   */
  private readonly lastGood = new Map<PolledField, { value: number; at: number }>();

  constructor() {
    this.globalStatsClient = HyperliquidGlobalStatsClient.getInstance();
    this.bridgedUsdcService = new BridgedUsdcService();
    this.validatorSummariesService = ValidatorSummariesService.getInstance();
    this.vaultsService = VaultsService.getInstance();
  }

  private formatHypeAmount(rawAmount: number): number {
    return Math.floor(rawAmount / Math.pow(10, this.HYPE_DECIMALS));
  }

  private remember(field: PolledField, value: number, now: number): void {
    this.lastGood.set(field, { value, at: now });
  }

  private recall(field: PolledField, now: number): number | null {
    const last = this.lastGood.get(field);
    return last && now - last.at <= GLOBAL_STATS_LAST_GOOD_MAX_AGE_MS ? last.value : null;
  }

  /**
   * Récupère les statistiques globales personnalisées pour la dashboard.
   *
   * Each source answers on its own: one that fails leaves its fields at their
   * last value (see `lastGood`) or null, and the others still answer. On a
   * cold Redis the validator and vault caches stay empty until their pollers'
   * first write (up to 30 s), which used to fail the whole route with a 500.
   */
  public async getDashboardGlobalStats(): Promise<DashboardGlobalStats> {
    // Bridged USDC comes from a shared 5 min cache of DefiLlama and never
    // throws: a DefiLlama outage leaves it null (or its last copy), not a 500.
    const [globalStats, bridgedUsdc, validatorSummaries, vaultsData] = await Promise.allSettled([
      this.globalStatsClient.getGlobalStats(),
      this.bridgedUsdcService.getLatestBridgedUsdc(),
      this.validatorSummariesService.getValidatorSummaries(),
      this.vaultsService.getVaultsList()
    ]);

    const now = Date.now();
    const failed: Record<string, string> = {};
    const reason = (result: PromiseRejectedResult): string =>
      result.reason instanceof Error ? result.reason.message : String(result.reason);

    if (globalStats.status === 'fulfilled') {
      this.remember('numberOfUsers', globalStats.value.nUsers, now);
      this.remember('dailyVolume', globalStats.value.dailyVolume, now);
    } else {
      failed.globalStats = reason(globalStats);
    }

    if (validatorSummaries.status === 'fulfilled') {
      // Calculer le total de HYPE staké
      const rawTotalHypeStake = validatorSummaries.value.reduce(
        (total: number, validator: ValidatorSummary) => total + validator.stake,
        0
      );
      this.remember('totalHypeStake', this.formatHypeAmount(rawTotalHypeStake), now);
    } else {
      failed.validators = reason(validatorSummaries);
    }

    if (vaultsData.status === 'fulfilled') {
      this.remember('vaultsTvl', vaultsData.value.pagination.totalTvl, now);
    } else {
      failed.vaults = reason(vaultsData);
    }

    if (bridgedUsdc.status === 'rejected') failed.bridgedUsdc = reason(bridgedUsdc);

    if (Object.keys(failed).length > 0) {
      logDeduplicator.warn('Dashboard global stats served without some sources', { failed });
    }

    return {
      numberOfUsers: this.recall('numberOfUsers', now),
      dailyVolume: this.recall('dailyVolume', now),
      bridgedUsdc: bridgedUsdc.status === 'fulfilled' ? bridgedUsdc.value : null,
      totalHypeStake: this.recall('totalHypeStake', now),
      vaultsTvl: this.recall('vaultsTvl', now)
    };
  }
}
