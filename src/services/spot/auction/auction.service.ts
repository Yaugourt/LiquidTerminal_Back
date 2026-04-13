import { SpotDeployStateApiService } from './auctionTiming.service';
import { AuctionInfo, AuctionTimingInfo, AuctionInfoWithCurrency, SplitAuctionsResponse } from '../../../types/auction.types';
import { Token } from '../../../types/market.types';
import { redisService } from '../../../core/redis.service';
import { AuctionError } from '../../../errors/spot.errors';
import { logDeduplicator } from '../../../utils/logDeduplicator';

export class AuctionPageService {
  private static instance: AuctionPageService;
  private static readonly HYPE_TRANSITION_TIMESTAMP = 1748277000047;

  private readonly UPDATE_CHANNEL = 'hypurrscan:auctions:updated';
  private readonly CACHE_KEY = 'hypurrscan:auctions';
  private readonly SPOT_CACHE_KEY = 'spot:raw_data';

  private constructor(
    private spotDeployStateApi: SpotDeployStateApiService
  ) {
    this.setupSubscriptions();
  }

  public static getInstance(spotDeployStateApi: SpotDeployStateApiService): AuctionPageService {
    if (!AuctionPageService.instance) {
      AuctionPageService.instance = new AuctionPageService(spotDeployStateApi);
    }
    return AuctionPageService.instance;
  }

  private setupSubscriptions(): void {
    redisService.subscribe(this.UPDATE_CHANNEL, async (message) => {
      try {
        const { type, timestamp } = JSON.parse(message);
        if (type === 'DATA_UPDATED') {
          logDeduplicator.info('Hypurrscan cache updated', { timestamp });
        }
      } catch (error) {
        logDeduplicator.error('Error processing cache update:', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private processAuctionData(auction: AuctionInfo): AuctionInfoWithCurrency {
    const isHype = auction.time >= AuctionPageService.HYPE_TRANSITION_TIMESTAMP;
    const deployGasNumber = parseFloat(auction.deployGas);
    
    return {
      ...auction,
      currency: isHype ? 'HYPE' : 'USDC',
      deployGasAbs: Math.abs(deployGasNumber).toString(),
      deployGas: isHype ? Math.abs(deployGasNumber).toString() : auction.deployGas
    };
  }

  private validateCurrencyTransition(auctions: AuctionInfoWithCurrency[]): void {
    const transitionAuction = auctions.find(a => a.time === AuctionPageService.HYPE_TRANSITION_TIMESTAMP);
    
    if (transitionAuction && parseFloat(transitionAuction.deployGas) > 0) {
      logDeduplicator.warn('Unexpected positive value at HYPE transition', {
        auction: transitionAuction
      });
    }

    // Vérification supplémentaire pour les valeurs négatives
    const negativeBeforeTransition = auctions
      .filter(a => a.time < AuctionPageService.HYPE_TRANSITION_TIMESTAMP)
      .some(a => parseFloat(a.deployGas) < 0);

    if (negativeBeforeTransition) {
      logDeduplicator.warn('Negative values found before HYPE transition');
    }
  }

  public async getAllAuctions(): Promise<SplitAuctionsResponse> {
    try {
      const cachedData = await redisService.get(this.CACHE_KEY);
      if (!cachedData) {
        logDeduplicator.error('No auction data in cache');
        throw new AuctionError('No auction data available in cache');
      }

      const spotCachedData = await redisService.get(this.SPOT_CACHE_KEY);
      if (!spotCachedData) {
        logDeduplicator.error('No spot data in cache');
        throw new AuctionError('No spot data available in cache');
      }

      const auctions = JSON.parse(cachedData) as AuctionInfo[];
      const [spotContext] = JSON.parse(spotCachedData);

      if (!spotContext || !spotContext.tokens) {
        logDeduplicator.error('Invalid spot data format in cache');
        throw new AuctionError('Invalid spot data format');
      }

      // Enrichir les données avec les informations de token
      const enrichedAuctions = auctions.map(auction => {
        const token = spotContext.tokens.find((t: Token) => t.name === auction.name);
        return {
          ...auction,
          tokenId: token?.tokenId,
          index: token?.index
        };
      });

      // Traiter et séparer les auctions
      const processedAuctions = enrichedAuctions
        .map(auction => this.processAuctionData(auction))
        .sort((a, b) => a.time - b.time);

      // Valider la transition
      this.validateCurrencyTransition(processedAuctions);

      // Séparer en deux tableaux
      const { usdcAuctions, hypeAuctions } = processedAuctions.reduce(
        (acc, auction) => {
          if (auction.currency === 'USDC') {
            acc.usdcAuctions.push(auction);
          } else {
            acc.hypeAuctions.push(auction);
          }
          return acc;
        },
        { usdcAuctions: [] as AuctionInfoWithCurrency[], hypeAuctions: [] as AuctionInfoWithCurrency[] }
      );

      // Calculer les totaux dépensés
      const totalUsdcSpent = usdcAuctions
        .reduce((sum, auction) => sum + parseFloat(auction.deployGas), 0)
        .toString();
      
      const totalHypeSpent = hypeAuctions
        .reduce((sum, auction) => sum + parseFloat(auction.deployGasAbs), 0)
        .toString();

      logDeduplicator.info('Auctions split successfully', {
        totalCount: processedAuctions.length,
        usdcCount: usdcAuctions.length,
        hypeCount: hypeAuctions.length,
        totalUsdcSpent,
        totalHypeSpent
      });

      return {
        usdcAuctions,
        hypeAuctions,
        splitTimestamp: AuctionPageService.HYPE_TRANSITION_TIMESTAMP,
        totalUsdcSpent,
        totalHypeSpent
      };
    } catch (error) {
      if (error instanceof AuctionError) {
        throw error;
      }
      logDeduplicator.error('Error retrieving auctions:', { error: error instanceof Error ? error.message : String(error) });
      throw new AuctionError('Failed to retrieve auctions data');
    }
  }

  public async getAuctionTiming(): Promise<AuctionTimingInfo> {
    try {
      const timing = await this.spotDeployStateApi.getAuctionTiming();
      logDeduplicator.info('Auction timing retrieved successfully', { 
        currentStartTime: timing.currentAuction.startTime,
        currentEndTime: timing.currentAuction.endTime,
        nextStartTime: timing.nextAuction.startTime
      });
      return timing;
    } catch (error) {
      logDeduplicator.error('Error fetching auction timing:', { error: error instanceof Error ? error.message : String(error) });
      throw new AuctionError(error instanceof Error ? error.message : 'Failed to fetch auction timing');
    }
  }
}