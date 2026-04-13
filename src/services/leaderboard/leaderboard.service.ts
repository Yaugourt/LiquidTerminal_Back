import { 
  LeaderboardQueryParams, 
  ProcessedLeaderboardEntry, 
  PaginatedLeaderboardResponse,
  LeaderboardError,
  LeaderboardNotFoundError,
  WindowPerformance
} from '../../types/leaderboard.types';
import { HyperliquidLeaderboardClient } from '../../clients/hyperliquid/leaderboard/leaderboard.client';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class LeaderboardService {
  private static instance: LeaderboardService;
  private readonly client: HyperliquidLeaderboardClient;
  private readonly UPDATE_CHANNEL = 'leaderboard:updated';
  private lastUpdate: number = 0;

  private constructor() {
    this.client = HyperliquidLeaderboardClient.getInstance();
    this.setupSubscriptions();
  }

  public static getInstance(): LeaderboardService {
    if (!LeaderboardService.instance) {
      LeaderboardService.instance = new LeaderboardService();
    }
    return LeaderboardService.instance;
  }

  private setupSubscriptions(): void {
    redisService.subscribe(this.UPDATE_CHANNEL, (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'DATA_UPDATED') {
          this.lastUpdate = data.timestamp;
          logDeduplicator.info('Leaderboard service notified of data update', {
            timestamp: this.lastUpdate
          });
        }
      } catch (error) {
        logDeduplicator.error('Error processing leaderboard update notification:', { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  public async getLeaderboard(params: LeaderboardQueryParams): Promise<PaginatedLeaderboardResponse> {
    try {
      const rawData = await this.client.getLeaderboardData();
      
      if (!rawData || !rawData.leaderboardRows) {
        throw new LeaderboardNotFoundError();
      }

      // Traiter les données brutes
      const processedData = this.processLeaderboardData(rawData.leaderboardRows);

      // Appliquer le tri
      const sortedData = this.sortLeaderboard(processedData, params);

      // Appliquer la pagination
      const paginatedResult = this.paginateResults(sortedData, params);

      logDeduplicator.info('Leaderboard data retrieved successfully', {
        total: processedData.length,
        timeline: params.timeline,
        sortBy: params.sortBy,
        order: params.order,
        page: params.page,
        limit: params.limit
      });

      return paginatedResult;
    } catch (error) {
      if (error instanceof LeaderboardError) {
        throw error;
      }
      logDeduplicator.error('Error retrieving leaderboard:', { error: error instanceof Error ? error.message : String(error), params });
      throw new LeaderboardError('Failed to retrieve leaderboard data');
    }
  }

  private processLeaderboardData(rawRows: any[]): ProcessedLeaderboardEntry[] {
    return rawRows.map(row => {
      const performances: Record<string, WindowPerformance> = {};
      
      // Convertir les performances en objet indexé
      row.windowPerformances.forEach(([timeline, performance]: [string, WindowPerformance]) => {
        performances[timeline] = performance;
      });

      return {
        ethAddress: row.ethAddress,
        accountValue: parseFloat(row.accountValue),
        displayName: row.displayName,
        prize: row.prize,
        day: performances.day || { pnl: '0', roi: '0', vlm: '0' },
        week: performances.week || { pnl: '0', roi: '0', vlm: '0' },
        month: performances.month || { pnl: '0', roi: '0', vlm: '0' },
        allTime: performances.allTime || { pnl: '0', roi: '0', vlm: '0' }
      };
    });
  }

  private sortLeaderboard(
    data: ProcessedLeaderboardEntry[], 
    params: LeaderboardQueryParams
  ): ProcessedLeaderboardEntry[] {
    const { timeline = 'day', sortBy = 'pnl', order = 'desc' } = params;

    return data.sort((a, b) => {
      let valueA: number;
      let valueB: number;

      // Obtenir les valeurs à comparer selon la timeline et le critère de tri
      const performanceA = a[timeline as keyof ProcessedLeaderboardEntry] as WindowPerformance;
      const performanceB = b[timeline as keyof ProcessedLeaderboardEntry] as WindowPerformance;

      switch (sortBy) {
        case 'pnl':
          valueA = parseFloat(performanceA.pnl);
          valueB = parseFloat(performanceB.pnl);
          break;
        case 'roi':
          valueA = parseFloat(performanceA.roi);
          valueB = parseFloat(performanceB.roi);
          break;
        case 'vlm':
          valueA = parseFloat(performanceA.vlm);
          valueB = parseFloat(performanceB.vlm);
          break;
        default:
          valueA = parseFloat(performanceA.pnl);
          valueB = parseFloat(performanceB.pnl);
      }

      // Appliquer l'ordre de tri
      if (order === 'asc') {
        return valueA - valueB;
      } else {
        return valueB - valueA;
      }
    });
  }

  private paginateResults(
    data: ProcessedLeaderboardEntry[], 
    params: LeaderboardQueryParams
  ): PaginatedLeaderboardResponse {
    const { page = 1, limit = 20 } = params;
    const offset = (page - 1) * limit;
    const total = data.length;
    const pages = Math.ceil(total / limit);
    const paginatedData = data.slice(offset, offset + limit);

    return {
      data: paginatedData,
      pagination: {
        total,
        page,
        limit,
        totalPages: pages,
        hasNext: page < pages,
        hasPrevious: page > 1
      }
    };
  }

  public async getLeaderboardEntry(ethAddress: string): Promise<ProcessedLeaderboardEntry | null> {
    try {
      const rawData = await this.client.getLeaderboardData();
      
      if (!rawData || !rawData.leaderboardRows) {
        return null;
      }

      const processedData = this.processLeaderboardData(rawData.leaderboardRows);
      const entry = processedData.find(entry => 
        entry.ethAddress.toLowerCase() === ethAddress.toLowerCase()
      );

      if (entry) {
        logDeduplicator.info('Leaderboard entry found', { ethAddress });
      }

      return entry || null;
    } catch (error) {
      logDeduplicator.error('Error retrieving leaderboard entry:', { error: error instanceof Error ? error.message : String(error), ethAddress });
      return null;
    }
  }

  public getLastUpdate(): number {
    return this.lastUpdate;
  }
} 