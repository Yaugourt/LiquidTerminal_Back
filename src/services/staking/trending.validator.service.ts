import { TrendingValidator, ValidatorSummary } from '../../types/staking.types';
import { isFoundationValidator } from '../../constants/staking.constants';
import { redisService } from '../../core/redis.service';
import { TrendingValidatorError } from '../../errors/staking.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

export type SortBy = 'stake' | 'apr';

export class TrendingValidatorService {
  private static instance: TrendingValidatorService;
  private readonly CACHE_KEY = 'staking:validators:raw_data';
  private readonly UPDATE_CHANNEL = 'staking:validators:updated';
  private lastUpdate: number = 0;

  private constructor() {
    this.setupSubscriptions();
  }

  private setupSubscriptions(): void {
    redisService.subscribe(this.UPDATE_CHANNEL, async (message) => {
      try {
        const { type, timestamp } = JSON.parse(message);
        if (type === 'DATA_UPDATED') {
          this.lastUpdate = timestamp;
          logDeduplicator.info('Validator data updated', { timestamp });
        }
      } catch (error) {
        logDeduplicator.error('Error processing cache update:', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  public static getInstance(): TrendingValidatorService {
    if (!TrendingValidatorService.instance) {
      TrendingValidatorService.instance = new TrendingValidatorService();
    }
    return TrendingValidatorService.instance;
  }

  /**
   * Récupère le top 5 des validateurs classés par nombre de tokens stake ou APR depuis le cache
   */
  public async getTrendingValidators(sortBy: SortBy = 'stake'): Promise<TrendingValidator[]> {
    try {
      const cachedData = await redisService.get(this.CACHE_KEY);
      if (!cachedData) {
        throw new TrendingValidatorError('No validator data available in cache');
      }

      const validators = JSON.parse(cachedData) as ValidatorSummary[];
      
      // Convertir les stakes (diviser par 10^8) et trier par ordre décroissant
      const formattedValidators = validators.map((validator: ValidatorSummary) => {
        // Vérifier si stats existe et contient les données nécessaires
        const predictedApr = validator.stats && validator.stats.length > 0 && validator.stats[0][1] 
          ? parseFloat(validator.stats[0][1].predictedApr) * 100 
          : 0;
        
        return {
          name: validator.name,
          stake: Number(validator.stake) / 100000000,
          apr: predictedApr,
          commission: parseFloat(validator.commission) * 100,
          uptime: validator.stats && validator.stats.length > 0 && validator.stats[0][1] 
            ? parseFloat(validator.stats[0][1].uptimeFraction) * 100 
            : 0,
          isActive: validator.isActive,
          nRecentBlocks: validator.nRecentBlocks
        };
      });

      // Agréger les validateurs de Hyper Foundation
      const hyperFoundationValidators = formattedValidators.filter((v: TrendingValidator) => isFoundationValidator(v.name));
      const otherValidators = formattedValidators.filter((v: TrendingValidator) => !isFoundationValidator(v.name));

      // Créer l'entrée agrégée pour Hyper Foundation
      const hyperFoundationAggregate: TrendingValidator = {
        name: 'Hyper Foundation (All)',
        stake: hyperFoundationValidators.reduce((sum: number, v: TrendingValidator) => sum + v.stake, 0),
        apr: hyperFoundationValidators[0]?.apr || 0,
        commission: hyperFoundationValidators[0]?.commission || 0,
        uptime: hyperFoundationValidators[0]?.uptime || 0,
        isActive: hyperFoundationValidators[0]?.isActive || false,
        nRecentBlocks: hyperFoundationValidators[0]?.nRecentBlocks || 0
      };

      // Combiner et trier
      const allValidators = [
        hyperFoundationAggregate,
        ...otherValidators
      ].sort((a, b) => sortBy === 'stake' ? b.stake - a.stake : b.apr - a.apr)
        .slice(0, 5);
      
      logDeduplicator.info('Trending validators retrieved from cache', { 
        count: allValidators.length,
        sortBy,
        hyperFoundationStake: hyperFoundationAggregate.stake,
        lastUpdate: this.lastUpdate
      });

      return allValidators;
    } catch (error) {
      logDeduplicator.error('Error fetching trending validators from cache:', { 
        error: error instanceof Error ? error.message : String(error), 
        sortBy 
      });
      throw new TrendingValidatorError('Failed to fetch trending validators from cache');
    }
  }
} 