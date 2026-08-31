import { BaseApiService } from '../../../core/base.api.service';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { redisService } from '../../../core/redis.service';
import { prismaHistorical } from '../../../core/prisma.historical.service';
import { withDistributedLock } from '../../../utils/distributedLock';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { TopTradersService } from '../../../services/toptraders/toptraders.service';
import {
  AggregatePositioning,
  ClearinghouseState,
  CoinPositioning,
  PositioningHistoryPoint,
} from '../../../types/positioning.types';

const HL_API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';

const CACHE_KEY = 'positioning:aggregate';
const UPDATE_CHANNEL = 'positioning:updated';
const LOCK_KEY = 'poll:aggregate-positioning';
const LOCK_TTL = 50;
const UPDATE_INTERVAL = 60000;
// TTL outlives the poll cycle so the scheduled poll always rewrites the key
// before it expires, avoiding a cold window that triggers on-demand refreshes.
const CACHE_TTL = 120;

/** Upper bound on the fanned-out cohort, so a refresh cannot balloon upstream calls. */
const COHORT_CAP = 80;
/** Concurrent clearinghouseState calls; kept under BaseApiService's global cap of 50. */
const FANOUT_CONCURRENCY = 12;

/** Run `fn` over `items` with at most `limit` in flight; never rejects (settled per item). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false }>> {
  const out: Array<{ ok: true; value: R } | { ok: false }> = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = { ok: true, value: await fn(items[i]) };
      } catch {
        out[i] = { ok: false };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Aggregate positioning poller.
 *
 * Every cycle it takes the smart-money cohort (union of the top traders by
 * volume and by PnL, already cached by TopTradersService), fans out
 * Hyperliquid `clearinghouseState` for each, and sums every open position's
 * notional into per-coin long/short totals. The heavy fan-out lives here on
 * the server, cached, so the browser reads one small snapshot.
 *
 * Circuit breaker id: `positioning`. Keyless upstream (HL public /info).
 */
export class AggregatePositioningClient extends BaseApiService {
  private static instance: AggregatePositioningClient;

  private circuitBreaker: CircuitBreakerService;
  private topTraders: TopTradersService;
  private pollingTimeout: NodeJS.Timeout | null = null;
  private pollingStopped = true;
  private consecutiveFailures = 0;

  private constructor() {
    super(HL_API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('positioning');
    this.topTraders = TopTradersService.getInstance();
  }

  public static getInstance(): AggregatePositioningClient {
    if (!AggregatePositioningClient.instance) {
      AggregatePositioningClient.instance = new AggregatePositioningClient();
    }
    return AggregatePositioningClient.instance;
  }

  public startPolling(): void {
    if (!this.pollingStopped) {
      logDeduplicator.warn('Aggregate positioning polling already started');
      return;
    }
    this.pollingStopped = false;
    void this.tick();
  }

  public stopPolling(): void {
    this.pollingStopped = true;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
  }

  /** Self-rescheduling poll loop with exponential backoff on repeated failure. */
  private async tick(): Promise<void> {
    if (this.pollingStopped) return;
    try {
      await this.updatePositioning();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      logDeduplicator.error('Error in aggregate positioning polling:', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });
    }
    if (this.pollingStopped) return;
    const multiplier = Math.min(Math.pow(2, this.consecutiveFailures), 10);
    this.pollingTimeout = setTimeout(() => void this.tick(), UPDATE_INTERVAL * multiplier);
  }

  /** Union of the top traders by volume and by PnL, deduped and capped. */
  private async getCohort(): Promise<string[]> {
    const [byVolume, byPnl] = await Promise.all([
      this.topTraders.getTopTraders({ sort: 'volume', limit: 50 }),
      this.topTraders.getTopTraders({ sort: 'pnl_pos', limit: 50 }),
    ]);
    const seen = new Set<string>();
    for (const t of [...byVolume.data, ...byPnl.data]) {
      const addr = t.user?.toLowerCase();
      if (addr) seen.add(addr);
      if (seen.size >= COHORT_CAP) break;
    }
    return [...seen];
  }

  private async getClearinghouseState(address: string): Promise<ClearinghouseState> {
    return this.circuitBreaker.execute(() =>
      this.post<ClearinghouseState>('', { type: 'clearinghouseState', user: address })
    );
  }

  /** Fold every cohort member's open positions into per-coin long/short notionals. */
  private aggregate(states: ClearinghouseState[]): AggregatePositioning {
    const byCoin = new Map<string, CoinPositioning>();

    for (const state of states) {
      for (const entry of state.assetPositions ?? []) {
        const p = entry.position;
        const szi = parseFloat(p.szi);
        const notional = Math.abs(parseFloat(p.positionValue ?? '0'));
        if (!Number.isFinite(szi) || szi === 0 || !Number.isFinite(notional) || notional <= 0) continue;

        let row = byCoin.get(p.coin);
        if (!row) {
          row = {
            coin: p.coin,
            longNotional: 0,
            shortNotional: 0,
            netNotional: 0,
            longCount: 0,
            shortCount: 0,
            traderCount: 0,
          };
          byCoin.set(p.coin, row);
        }
        if (szi > 0) {
          row.longNotional += notional;
          row.longCount += 1;
        } else {
          row.shortNotional += notional;
          row.shortCount += 1;
        }
        row.traderCount += 1;
      }
    }

    let longTotal = 0;
    let shortTotal = 0;
    const coins = [...byCoin.values()].map((row) => {
      row.netNotional = row.longNotional - row.shortNotional;
      longTotal += row.longNotional;
      shortTotal += row.shortNotional;
      return row;
    });
    // Most-positioned markets first, by gross exposure.
    coins.sort((a, b) => b.longNotional + b.shortNotional - (a.longNotional + a.shortNotional));

    const gross = longTotal + shortTotal;
    return {
      coins,
      totals: {
        longNotional: longTotal,
        shortNotional: shortTotal,
        netNotional: longTotal - shortTotal,
        longShare: gross > 0 ? longTotal / gross : 0,
      },
      tradersScanned: states.length,
      cohortSize: 0, // filled by the caller (states already dropped the non-answering ones)
      updatedAt: new Date().toISOString(),
    };
  }

  /** Rebuild the snapshot from upstream and cache it. Lock-guarded for multi-instance. */
  private async updatePositioning(): Promise<void> {
    const executed = await withDistributedLock(LOCK_KEY, LOCK_TTL, async () => {
      const cohort = await this.getCohort();
      if (cohort.length === 0) {
        throw new Error('Empty top-trader cohort; cannot build positioning');
      }

      const results = await mapWithConcurrency(cohort, FANOUT_CONCURRENCY, (addr) =>
        this.getClearinghouseState(addr)
      );
      const states = results.filter((r): r is { ok: true; value: ClearinghouseState } => r.ok).map((r) => r.value);
      if (states.length === 0) {
        throw new Error('All clearinghouseState fetches failed');
      }

      const snapshot = this.aggregate(states);
      snapshot.cohortSize = cohort.length;

      await redisService.set(CACHE_KEY, JSON.stringify(snapshot), CACHE_TTL);
      await redisService.publish(
        UPDATE_CHANNEL,
        JSON.stringify({ type: 'DATA_UPDATED', timestamp: Date.now() })
      );

      // Persist an hourly point so the net bias can be charted over time. There
      // is no upstream history for open-position state, so we build it here.
      await this.persistSnapshot(snapshot);
    });

    if (!executed) {
      logDeduplicator.info('Aggregate positioning update skipped - another instance holds the lock');
    }
  }

  /** Cached snapshot; triggers an on-demand build on a cold cache. */
  public async getPositioning(): Promise<AggregatePositioning> {
    const cached = await redisService.get(CACHE_KEY);
    if (cached) return JSON.parse(cached) as AggregatePositioning;

    await this.updatePositioning();
    const reRead = await redisService.get(CACHE_KEY);
    if (reRead) return JSON.parse(reRead) as AggregatePositioning;

    throw new Error('Aggregate positioning unavailable');
  }

  /**
   * Best-effort hourly persistence of the net bias. A missing table (migration
   * not yet applied) or any DB hiccup must never break the live feature, so
   * every failure is swallowed with a warning.
   */
  private async persistSnapshot(snap: AggregatePositioning): Promise<void> {
    try {
      const hour = new Date(snap.updatedAt);
      hour.setUTCMinutes(0, 0, 0);
      const row = {
        longNotional: snap.totals.longNotional,
        shortNotional: snap.totals.shortNotional,
        netNotional: snap.totals.netNotional,
        longShare: snap.totals.longShare,
        tradersScanned: snap.tradersScanned,
      };
      await prismaHistorical.positioningSnapshot.upsert({
        where: { time: hour },
        create: { time: hour, ...row },
        update: row,
      });
    } catch (err) {
      logDeduplicator.warn('Positioning snapshot persist skipped (best-effort)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Net-bias history over the last `hours`, oldest first. Returns [] if the
   * table does not exist yet (pre-migration) or on any read error.
   */
  public async getHistory(hours: number): Promise<PositioningHistoryPoint[]> {
    try {
      const since = new Date(Date.now() - hours * 3_600_000);
      const rows = await prismaHistorical.positioningSnapshot.findMany({
        where: { time: { gte: since } },
        orderBy: { time: 'asc' },
      });
      return rows.map((r) => ({
        time: r.time.getTime(),
        longNotional: Number(r.longNotional),
        shortNotional: Number(r.shortNotional),
        netNotional: Number(r.netNotional),
        longShare: Number(r.longShare),
      }));
    } catch (err) {
      logDeduplicator.warn('Positioning history unavailable (best-effort)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
