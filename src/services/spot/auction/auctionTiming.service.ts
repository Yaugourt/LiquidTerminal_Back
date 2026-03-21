import { AuctionTimingInfo } from '../../../types/auction.types';
import { HyperliquidSpotDeployClient } from '../../../clients/hyperliquid/spot/spot.deploy.client';
import { AuctionError, InvalidAuctionDataError } from '../../../errors/spot.errors';
import { logDeduplicator } from '../../../utils/logDeduplicator';

export class SpotDeployStateApiService {
  private static instance: SpotDeployStateApiService; // Ajout pour Singleton

  private hyperliquidClient: HyperliquidSpotDeployClient;
  
  // Système de déduplication des logs
  private lastLogTimestamp: Record<string, number> = {};
  private readonly LOG_THROTTLE_MS = 1000;

  // Le constructeur devient privé
  private constructor() {
    this.hyperliquidClient = HyperliquidSpotDeployClient.getInstance();
  }

  // Méthode statique pour récupérer l'instance unique
  public static getInstance(): SpotDeployStateApiService {
    if (!SpotDeployStateApiService.instance) {
      SpotDeployStateApiService.instance = new SpotDeployStateApiService();
    }
    return SpotDeployStateApiService.instance;
  }

  /**
   * Log un message une seule fois dans un intervalle de temps défini
   */
  private logOnce(message: string, metadata: Record<string, any> = {}): void {
    const now = Date.now();
    const key = `${message}:${JSON.stringify(metadata)}`;
    
    if (!this.lastLogTimestamp[key] || now - this.lastLogTimestamp[key] > this.LOG_THROTTLE_MS) {
      logDeduplicator.info(message, metadata);
      this.lastLogTimestamp[key] = now;
    }
  }

  /**
   * Récupère les informations de timing des enchères
   */
  public async getAuctionTiming(): Promise<AuctionTimingInfo> {
    try {
      const response = await this.hyperliquidClient.getSpotDeployState();
      if (!response) {
        logDeduplicator.warn('No spot deploy state data available');
        throw new InvalidAuctionDataError('No spot deploy state data available');
      }

      // L'API retourne directement l'objet avec states et gasAuction
      const gasAuction = response.gasAuction;
      if (!gasAuction) {
        logDeduplicator.warn('No gas auction data available');
        throw new InvalidAuctionDataError('No gas auction data available');
      }

      const currentStartTime = gasAuction.startTimeSeconds * 1000;
      const currentEndTime = (gasAuction.startTimeSeconds + gasAuction.durationSeconds) * 1000;
      const nextStartTime = currentEndTime + (31 * 3600 * 1000);
      const nextStartGas = gasAuction.endGas ? 
        (Number(gasAuction.endGas) * 2).toString() : 
        "0";

      this.logOnce('Auction timing retrieved successfully', { 
        currentStartTime,
        currentEndTime,
        nextStartTime,
        startGas: gasAuction.startGas,
        currentGas: gasAuction.currentGas,
        endGas: gasAuction.endGas || "0"
      });
      
      return {
        currentAuction: {
          startTime: currentStartTime,
          endTime: currentEndTime,
          startGas: gasAuction.startGas,
          currentGas: gasAuction.currentGas,
          endGas: gasAuction.endGas || "0"
        },
        nextAuction: {
          startTime: nextStartTime,
          startGas: nextStartGas
        }
      };
    } catch (error) {
      logDeduplicator.error('Error fetching auction timing:', { error: error instanceof Error ? error.message : String(error) });
      if (error instanceof InvalidAuctionDataError) {
        throw error;
      }
      throw new AuctionError(error instanceof Error ? error.message : 'Failed to fetch auction timing');
    }
  }

  /**
   * Récupère le poids de la requête pour le rate limiting
   */
  public getRequestWeight(): number {
    return HyperliquidSpotDeployClient.getRequestWeight();
  }
}