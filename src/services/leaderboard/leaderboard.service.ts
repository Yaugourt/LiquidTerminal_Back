import {
  LeaderboardQueryParams,
  LeaderboardResponse,
  ProcessedLeaderboardEntry,
  PaginatedLeaderboardResponse,
  LeaderboardError,
  LeaderboardNotFoundError,
  WindowPerformance
} from '../../types/leaderboard.types';
import { HyperliquidLeaderboardClient } from '../../clients/hyperliquid/leaderboard/leaderboard.client';
import { logDeduplicator } from '../../utils/logDeduplicator';

type Timeline = 'day' | 'week' | 'month' | 'allTime';
type Metric = 'pnl' | 'roi' | 'vlm';

const TIMELINES: ReadonlySet<string> = new Set<Timeline>(['day', 'week', 'month', 'allTime']);

/**
 * Everything derived from one upstream snapshot. The raw payload has ~47k rows:
 * rebuilding the entries and re-sorting them with `parseFloat` in the
 * comparator used to cost every request hundreds of milliseconds, so each
 * snapshot is processed once and each sort order computed once.
 */
interface LeaderboardView {
  rows: ProcessedLeaderboardEntry[];
  sorted: Map<string, ProcessedLeaderboardEntry[]>;
  byAddress: Map<string, ProcessedLeaderboardEntry> | null;
  stats: LeaderboardStats | null;
}

/** Aggregates over every row of the snapshot (all-time window). */
export interface LeaderboardStats {
  totalParticipants: number;
  topPerformer: ProcessedLeaderboardEntry | null;
  averageAccountValue: number;
  totalVolume: number;
  totalPnl: number;
}

export class LeaderboardService {
  private static instance: LeaderboardService;
  private readonly client: HyperliquidLeaderboardClient;
  // Keyed by the client's snapshot: the view is collected with it.
  private readonly views = new WeakMap<LeaderboardResponse, LeaderboardView>();

  private constructor() {
    this.client = HyperliquidLeaderboardClient.getInstance();
  }

  public static getInstance(): LeaderboardService {
    if (!LeaderboardService.instance) {
      LeaderboardService.instance = new LeaderboardService();
    }
    return LeaderboardService.instance;
  }

  public async getLeaderboard(params: LeaderboardQueryParams): Promise<PaginatedLeaderboardResponse> {
    try {
      const rawData = await this.client.getLeaderboardData();

      if (!rawData || !rawData.leaderboardRows) {
        throw new LeaderboardNotFoundError();
      }

      const view = this.getView(rawData);

      // Appliquer le tri
      const sortedData = this.getSorted(view, params);

      // Appliquer la pagination
      const paginatedResult = this.paginateResults(sortedData, params);

      logDeduplicator.info('Leaderboard data retrieved successfully', {
        total: view.rows.length,
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

  /**
   * Totals over the whole board, not a page of it: computed once per snapshot
   * like the sorted views. Empty board: zeros and no top performer.
   */
  public async getStats(): Promise<LeaderboardStats> {
    try {
      const rawData = await this.client.getLeaderboardData();
      if (!rawData || !rawData.leaderboardRows) {
        throw new LeaderboardNotFoundError();
      }

      const view = this.getView(rawData);
      if (!view.stats) {
        const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
        let accountValue = 0;
        let volume = 0;
        let pnl = 0;
        for (const entry of view.rows) {
          accountValue += finite(entry.accountValue);
          volume += finite(parseFloat(entry.allTime.vlm));
          pnl += finite(parseFloat(entry.allTime.pnl));
        }
        const count = view.rows.length;
        view.stats = {
          totalParticipants: count,
          topPerformer: this.getSorted(view, { timeline: 'allTime', sortBy: 'pnl', order: 'desc' })[0] ?? null,
          averageAccountValue: count > 0 ? accountValue / count : 0,
          totalVolume: volume,
          totalPnl: pnl,
        };
      }
      return view.stats;
    } catch (error) {
      if (error instanceof LeaderboardError) {
        throw error;
      }
      logDeduplicator.error('Error computing leaderboard stats:', { error: error instanceof Error ? error.message : String(error) });
      throw new LeaderboardError('Failed to retrieve leaderboard data');
    }
  }

  private getView(rawData: LeaderboardResponse): LeaderboardView {
    let view = this.views.get(rawData);
    if (!view) {
      view = {
        rows: this.processLeaderboardData(rawData.leaderboardRows),
        sorted: new Map(),
        byAddress: null,
        stats: null,
      };
      this.views.set(rawData, view);
    }
    return view;
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

  /** Sorted copy of the snapshot's rows, computed once per sort order. */
  private getSorted(view: LeaderboardView, params: LeaderboardQueryParams): ProcessedLeaderboardEntry[] {
    const { timeline = 'day', sortBy = 'pnl', order = 'desc' } = params;
    const metric: Metric = sortBy === 'roi' || sortBy === 'vlm' ? sortBy : 'pnl';
    const direction = order === 'asc' ? 'asc' : 'desc';

    // Validated routes only send the four timelines; anything else keeps the
    // historical (unmemoized) behaviour rather than growing the cache.
    if (!TIMELINES.has(timeline)) {
      return this.sortLeaderboard(view.rows, timeline, metric, direction);
    }

    const key = `${timeline}:${metric}:${direction}`;
    let sorted = view.sorted.get(key);
    if (!sorted) {
      sorted = this.sortLeaderboard(view.rows, timeline, metric, direction);
      view.sorted.set(key, sorted);
    }
    return sorted;
  }

  /**
   * Same comparator results as before (`parseFloat` of the same strings, same
   * subtraction), only parsed once per row instead of once per comparison — so
   * the stable sort yields the exact same order, ties included.
   */
  private sortLeaderboard(
    rows: ProcessedLeaderboardEntry[],
    timeline: string,
    metric: Metric,
    direction: 'asc' | 'desc'
  ): ProcessedLeaderboardEntry[] {
    const keyed = rows.map((entry) => {
      const performance = entry[timeline as keyof ProcessedLeaderboardEntry] as WindowPerformance;
      return { entry, value: parseFloat(performance[metric]) };
    });

    keyed.sort(direction === 'asc'
      ? (a, b) => a.value - b.value
      : (a, b) => b.value - a.value);

    return keyed.map(({ entry }) => entry);
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

      const view = this.getView(rawData);
      if (!view.byAddress) {
        // First occurrence wins, like the `find` this replaces.
        const byAddress = new Map<string, ProcessedLeaderboardEntry>();
        for (const entry of view.rows) {
          if (typeof entry.ethAddress !== 'string') continue;
          const key = entry.ethAddress.toLowerCase();
          if (!byAddress.has(key)) byAddress.set(key, entry);
        }
        view.byAddress = byAddress;
      }
      const entry = view.byAddress.get(ethAddress.toLowerCase());

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
    return this.client.getLastUpdate();
  }
}