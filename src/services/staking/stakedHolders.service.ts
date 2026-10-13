import { HypurrscanTokenHoldersClient } from '../../clients/hypurrscan/tokenHolders.client';
import { StakedHolder } from '../../types/staking.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { OnDemandSnapshot } from '../../utils/onDemandSnapshot';
import { redisSnapshotStore } from '../../utils/redisSnapshotStore';

interface StakedHoldersStats {
  totalHolders: number;
  totalStaked: number;
  averageStaked: number;
  lastUpdate: number;
  distributionByRange: {
    range: string;
    holdersCount: number;
    totalStaked: number;
    percentage: number;
  }[];
  topHoldersStats: {
    topCount: number;
    totalStaked: number;
    percentage: number;
  }[];
}

/** No stakers list could be read or held: the routes answer 503. */
export class StakedHoldersUnavailableError extends Error {
  constructor() {
    super('Staked holders unavailable');
    this.name = 'StakedHoldersUnavailableError';
  }
}

/** Hypurrscan's stakedHYPE list, sorted once per download. */
interface StakedHoldersView {
  token: string;
  /** Hypurrscan regeneration time, in seconds. */
  lastUpdate: number;
  holdersCount: number;
  /** Largest stake first. */
  sorted: StakedHolder[];
  /** Hypurrscan's address → amount map (lowercased addresses). */
  amounts: Record<string, number>;
  /** Computed on the first stats request. */
  stats?: StakedHoldersStats;
}

const RANGES = [
  { min: 0, max: 10, label: '0-10' },
  { min: 10, max: 50, label: '10-50' },
  { min: 50, max: 250, label: '50-250' },
  { min: 250, max: 1000, label: '250-1000' },
  { min: 1000, max: 5000, label: '1000-5000' },
  { min: 5000, max: 25000, label: '5000-25000' },
  { min: 25000, max: 100000, label: '25000-100000' },
  { min: 100000, max: Infinity, label: '100000+' },
];

const TOP_COUNTS = [10, 50, 100, 500, 1000, 5000, 10000];

/** What Redis keeps of a view: the sorted list as [address, amount] pairs (the map and stats are rebuilt). */
interface StoredStakedHoldersView {
  token: string;
  lastUpdate: number;
  holdersCount: number;
  rows: Array<[string, number]>;
}

function encodeView(view: StakedHoldersView): StoredStakedHoldersView {
  return {
    token: view.token,
    lastUpdate: view.lastUpdate,
    holdersCount: view.holdersCount,
    rows: view.sorted.map((h) => [h.address, h.amount]),
  };
}

function decodeView(stored: StoredStakedHoldersView): StakedHoldersView {
  const sorted = stored.rows.map(([address, amount]) => ({ address, amount }));
  const amounts: Record<string, number> = {};
  for (const { address, amount } of sorted) amounts[address] = amount;
  return { token: stored.token, lastUpdate: stored.lastUpdate, holdersCount: stored.holdersCount, sorted, amounts };
}

/**
 * HYPE stakers, read from Hypurrscan's `/holders/stakedHYPE` (2.8 MB, ~49k
 * addresses, regenerated every ~10 min). A poller used to download it every
 * 50 s into Redis, whether or not anyone opened the stakers table, and each
 * request re-parsed and re-sorted the whole list. The list is now downloaded
 * only while someone reads it (OnDemandSnapshot) and sorted once per download.
 * The last list is also kept in Redis (gzipped) for MAX_STALE_MS, so a
 * restart, another instance or a Hypurrscan outage serves it instead of an
 * error.
 */
export class StakedHoldersService {
  private static instance: StakedHoldersService;

  /** Same windows as the token holders views: the upstream list moves every ~10 min. */
  private static readonly FRESH_MS = 10 * 60_000;
  private static readonly MAX_STALE_MS = 6 * 60 * 60_000;
  private static readonly STORE_KEY = 'staking:holders:view';

  private readonly client = HypurrscanTokenHoldersClient.getInstance();
  private readonly snapshot = new OnDemandSnapshot(() => this.fetchView(), {
    freshMs: StakedHoldersService.FRESH_MS,
    maxStaleMs: StakedHoldersService.MAX_STALE_MS,
    store: redisSnapshotStore<StakedHoldersView, StoredStakedHoldersView>(StakedHoldersService.STORE_KEY, {
      ttlS: StakedHoldersService.MAX_STALE_MS / 1000,
      compress: true,
      encode: encodeView,
      decode: decodeView,
    }),
  });

  private constructor() {}

  public static getInstance(): StakedHoldersService {
    if (!StakedHoldersService.instance) {
      StakedHoldersService.instance = new StakedHoldersService();
    }
    return StakedHoldersService.instance;
  }

  /**
   * Récupère les holders de stakedHYPE avec pagination et tri
   */
  public async getStakedHolders(page: number = 1, limit: number = 100): Promise<{
    holders: StakedHolder[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrevious: boolean;
    };
    metadata: {
      token: string;
      lastUpdate: number;
      holdersCount: number;
    };
  }> {
    // Validation des paramètres
    if (page < 1) {
      throw new Error('Page must be greater than 0');
    }

    if (limit < 1 || limit > 1000) {
      throw new Error('Limit must be between 1 and 1000');
    }

    try {
      const view = await this.view();

      const startIndex = (page - 1) * limit;
      const totalPages = Math.ceil(view.sorted.length / limit);

      return {
        holders: view.sorted.slice(startIndex, startIndex + limit),
        pagination: {
          page,
          limit,
          total: view.sorted.length,
          totalPages,
          hasNext: page < totalPages,
          hasPrevious: page > 1
        },
        metadata: {
          token: view.token,
          lastUpdate: view.lastUpdate,
          holdersCount: view.holdersCount
        }
      };
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) throw error;
      throw new Error(`Failed to fetch staked holders: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Récupère un holder spécifique par son adresse
   */
  public async getHolderByAddress(address: string): Promise<StakedHolder | null> {
    if (!address || typeof address !== 'string') {
      throw new Error('Valid address is required');
    }

    try {
      const { amounts } = await this.view();
      const key = address.toLowerCase();

      // Own keys only: `constructor` & co. are not addresses.
      if (Object.prototype.hasOwnProperty.call(amounts, key)) {
        return { address, amount: amounts[key] };
      }

      return null;
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) throw error;
      throw new Error(`Failed to fetch holder by address: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Récupère les top holders
   */
  public async getTopHolders(limit: number = 10): Promise<StakedHolder[]> {
    if (limit < 1 || limit > 100) {
      throw new Error('Limit must be between 1 and 100');
    }

    try {
      const result = await this.getStakedHolders(1, limit);
      return result.holders;
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) throw error;
      throw new Error(`Failed to fetch top holders: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Récupère les statistiques des holders
   */
  public async getHoldersStats(): Promise<StakedHoldersStats> {
    try {
      const view = await this.view();
      view.stats ??= computeStats(view);
      return view.stats;
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) throw error;
      throw new Error(`Failed to fetch holders stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async view(): Promise<StakedHoldersView> {
    const view = await this.snapshot.get();
    if (!view) {
      throw new StakedHoldersUnavailableError();
    }
    return view;
  }

  private async fetchView(): Promise<StakedHoldersView> {
    try {
      // Ahead of the token holders downloads: the /hype stakers table must not
      // wait behind other tokens' lists.
      const data = await this.client.getStakedHolders('HYPE', { priority: true });
      const amounts = data.holders ?? {};
      const entries = Object.entries(amounts);
      // An empty list is an upstream hiccup: don't serve it as "nobody
      // stakes" for the next minutes.
      if (entries.length === 0) {
        throw new Error('Hypurrscan returned no stakedHYPE holders');
      }

      const sorted = entries
        .map(([address, amount]) => ({ address, amount }))
        .sort((a, b) => b.amount - a.amount);

      logDeduplicator.info('Staked holders view built', { holders: sorted.length });
      return {
        token: data.token ?? 'stakedHYPE',
        lastUpdate: data.lastUpdate ?? 0,
        holdersCount: data.holdersCount ?? sorted.length,
        sorted,
        amounts,
      };
    } catch (error) {
      logDeduplicator.error('Failed to fetch staked holders', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function computeStats(view: StakedHoldersView): StakedHoldersStats {
  const holdersArray = view.sorted;
  const amounts = holdersArray.map(holder => holder.amount);
  const totalStaked = amounts.reduce((sum, amount) => sum + amount, 0);
  const averageStaked = amounts.length > 0 ? totalStaked / amounts.length : 0;

  const distributionByRange = RANGES.map(range => {
    const holdersInRange = holdersArray.filter(holder =>
      holder.amount >= range.min && holder.amount < range.max
    );

    const holdersCount = holdersInRange.length;
    const rangeTotal = holdersInRange.reduce((sum, holder) => sum + holder.amount, 0);
    const percentage = totalStaked > 0 ? (rangeTotal / totalStaked) * 100 : 0;

    return {
      range: range.label,
      holdersCount,
      totalStaked: rangeTotal,
      percentage: Math.round(percentage * 100) / 100 // Arrondir à 2 décimales
    };
  });

  const topHoldersStats = TOP_COUNTS.map(topCount => {
    const topHolders = holdersArray.slice(0, Math.min(topCount, holdersArray.length));
    const topTotal = topHolders.reduce((sum, holder) => sum + holder.amount, 0);
    const percentage = totalStaked > 0 ? (topTotal / totalStaked) * 100 : 0;

    return {
      topCount,
      totalStaked: topTotal,
      percentage: Math.round(percentage * 100) / 100 // Arrondir à 2 décimales
    };
  });

  return {
    totalHolders: view.holdersCount,
    totalStaked,
    averageStaked,
    lastUpdate: view.lastUpdate,
    distributionByRange,
    topHoldersStats
  };
}
