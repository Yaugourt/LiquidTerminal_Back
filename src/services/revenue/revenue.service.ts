import {
  RevenueBreakdown,
  RevenueDay,
  RevenueError,
  RevenueLifetime,
  RevenueMeta,
  RevenueSourceStatus,
  RevenueWindow,
} from '../../types/revenue.types';
import { FeeData } from '../../types/fees.types';
import { AuctionInfo } from '../../types/auction.types';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HypurrscanFeesHistoricalClient } from '../../clients/hypurrscan/feesHistorical.client';
import { HypurrscanClient } from '../../clients/hypurrscan/auction.client';
import { HypeDexerHip3Client } from '../../clients/hypedexer/rest/hip3/hip3.client';
import { HypeDexerHip4Client } from '../../clients/hypedexer/rest/hip4/hip4.client';
import { HypeDexerAnalyticsIndexerClient } from '../../clients/hypedexer/rest/analytics/analytics-indexer.client';

const MICRO_USD_DIVISOR = 1_000_000;
const SPOT_DEPLOYER_MULTIPLIER = 2;

const HIP3_CACHE_KEY = 'revenue:hip3:auctions';
const HIP3_CACHE_TTL_SECONDS = 30 * 60;
const HIP4_CACHE_KEY = 'revenue:hip4:daily-fees';
const HIP4_CACHE_TTL_SECONDS = 30 * 60;
const PRIORITY_CACHE_KEY = 'revenue:priority:daily';
const PRIORITY_CACHE_TTL_SECONDS = 30 * 60;
const BREAKDOWN_CACHE_PREFIX = 'revenue:breakdown:';
const BREAKDOWN_CACHE_TTL_SECONDS = 5 * 60;

const PERP_MARKETS_CACHE_KEY = 'perp:markets';

interface PerpMarketLite { name: string; price: number; }
interface Hip3AuctionRow { time: string; status: string; cleared_px: number | null; }
interface Hip3HistoryResponse { data?: Hip3AuctionRow[]; }
interface PriorityFeeRow { date: string; totalGas: number; }
interface PriorityFeeResponse { data?: PriorityFeeRow[]; }

/** A `/hip4/analytics?interval=1d` bucket — only the fields we aggregate. */
interface Hip4AnalyticsBucket {
  bucket: string;
  fees_usdc?: number | null;
  volume?: number | null;
}
interface Hip4AnalyticsResponse { data?: Hip4AnalyticsBucket[]; }

const WINDOW_DAYS: Record<Exclude<RevenueWindow, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

/** Format a Date as `YYYY-MM-DD` in UTC. */
function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Convert a unix seconds timestamp to its UTC date key. */
function secondsToDateKey(seconds: number): string {
  return utcDateKey(new Date(seconds * 1000));
}

/** Convert a unix milliseconds timestamp to its UTC date key. */
function msToDateKey(ms: number): string {
  return utcDateKey(new Date(ms));
}

/** Convert an ISO-like string (with or without Z) to its UTC date key. */
function isoToDateKey(iso: string): string {
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return utcDateKey(new Date(Number.isFinite(ms) ? ms : 0));
}

export class RevenueService {
  private static instance: RevenueService;

  private feesHistoricalClient = HypurrscanFeesHistoricalClient.getInstance();
  private auctionClient = HypurrscanClient.getInstance();
  private hip3Client = HypeDexerHip3Client.getInstance();
  private hip4Client = HypeDexerHip4Client.getInstance();
  private analyticsClient = HypeDexerAnalyticsIndexerClient.getInstance();

  private constructor() {}

  public static getInstance(): RevenueService {
    if (!RevenueService.instance) {
      RevenueService.instance = new RevenueService();
    }
    return RevenueService.instance;
  }

  public async getBreakdown(window: RevenueWindow): Promise<RevenueBreakdown> {
    const cacheKey = `${BREAKDOWN_CACHE_PREFIX}${window}`;
    const cached = await redisService.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const breakdown = await this.buildBreakdown(window);
    await redisService.set(cacheKey, JSON.stringify(breakdown), BREAKDOWN_CACHE_TTL_SECONDS);
    return breakdown;
  }

  private async buildBreakdown(window: RevenueWindow): Promise<RevenueBreakdown> {
    const [feesResult, auctionsResult, hip3Result, hip4Result, priorityResult, hypeUsdResult] = await Promise.allSettled([
      this.feesHistoricalClient.getHistoricalData(),
      this.auctionClient.getPastAuctions(),
      this.fetchHip3AuctionsCached(),
      this.fetchHip4DailyFeesCached(),
      this.fetchPriorityFeesCached(),
      this.readHypeUsd(),
    ]);

    const fees = feesResult.status === 'fulfilled' ? feesResult.value : [];
    const auctions = auctionsResult.status === 'fulfilled' ? auctionsResult.value : [];
    const hip3Rows = hip3Result.status === 'fulfilled' ? hip3Result.value : [];
    const hip4Rows = hip4Result.status === 'fulfilled' ? hip4Result.value : [];
    const priorityRows = priorityResult.status === 'fulfilled' ? priorityResult.value : [];
    const hypeUsd = hypeUsdResult.status === 'fulfilled' ? hypeUsdResult.value : null;

    if (feesResult.status === 'rejected') {
      logDeduplicator.error('RevenueService: fees historical fetch failed', { error: String(feesResult.reason) });
    }
    if (auctionsResult.status === 'rejected') {
      logDeduplicator.error('RevenueService: past auctions fetch failed', { error: String(auctionsResult.reason) });
    }
    if (hip3Result.status === 'rejected') {
      logDeduplicator.error('RevenueService: hip3 auctions fetch failed', { error: String(hip3Result.reason) });
    }
    if (hip4Result.status === 'rejected') {
      logDeduplicator.error('RevenueService: hip4 daily fees fetch failed', { error: String(hip4Result.reason) });
    }
    if (priorityResult.status === 'rejected') {
      logDeduplicator.error('RevenueService: priority fees fetch failed', { error: String(priorityResult.reason) });
    }

    if (fees.length === 0) {
      throw new RevenueError('No fees historical data available', 503, 'REVENUE_NO_DATA');
    }

    const perpSpotDaily = this.computePerpSpotDaily(fees);
    const hip1Daily = this.bucketHip1ByDay(auctions);
    const hip3Daily = this.bucketHip3ByDay(hip3Rows, hypeUsd);
    const hip4Daily = this.bucketHip4ByDay(hip4Rows);
    const priorityDaily = this.bucketPriorityByDay(priorityRows, hypeUsd);

    const allDates = new Set<string>([
      ...perpSpotDaily.keys(),
      ...hip1Daily.keys(),
      ...hip3Daily.keys(),
      ...hip4Daily.keys(),
      ...priorityDaily.keys(),
    ]);
    const sortedDates = Array.from(allDates).sort();

    const days: RevenueDay[] = sortedDates.map((date) => {
      const ps = perpSpotDaily.get(date) ?? { perp: 0, spot: 0 };
      const hip1 = hip1Daily.get(date) ?? 0;
      const hip3 = hip3Daily.get(date) ?? 0;
      const hip4 = hip4Daily.get(date) ?? 0;
      const priority = priorityDaily.get(date) ?? 0;
      const total = ps.perp + ps.spot + hip1 + hip3 + hip4 + priority;
      return { date, perp: ps.perp, spot: ps.spot, hip1, hip3, hip4, priority, total };
    });

    const lifetime = this.computeLifetime(days);
    const windowed = this.sliceByWindow(days, window);

    const meta: RevenueMeta = {
      spotMultiplier: SPOT_DEPLOYER_MULTIPLIER,
      hypeUsd,
      lastUpdate: Date.now(),
      sourceStatus: {
        perpSpot: feesResult.status === 'fulfilled' && fees.length > 0 ? 'ok' : 'error',
        hip1: auctionsResult.status === 'fulfilled' ? 'ok' : 'error',
        hip3: this.hip3Status(hip3Result, hypeUsd),
        hip4: hip4Result.status === 'fulfilled' ? 'ok' : 'error',
        priority: this.priorityStatus(priorityResult, hypeUsd),
      },
    };

    return { window, days: windowed, lifetime, meta };
  }

  /**
   * Compute daily perp & spot from the cumulative `/fees` series.
   *
   * Hypurrscan returns one cumulative point per ~day. We snap to UTC days by
   * keeping the LAST point of each day (closest to end-of-day cumulative
   * total), then diff consecutive days.
   *
   * spot is multiplied by SPOT_DEPLOYER_MULTIPLIER to reflect gross-user fees
   * (Hypurrscan stores the protocol share only — the deployer takes the other
   * half on HIP-1 spot pairs).
   */
  private computePerpSpotDaily(fees: FeeData[]): Map<string, { perp: number; spot: number }> {
    const lastPerDay = new Map<string, FeeData>();
    for (const point of fees) {
      const key = secondsToDateKey(point.time);
      const prev = lastPerDay.get(key);
      if (!prev || point.time > prev.time) {
        lastPerDay.set(key, point);
      }
    }

    const sortedDays = Array.from(lastPerDay.entries()).sort(([a], [b]) => a.localeCompare(b));
    const out = new Map<string, { perp: number; spot: number }>();

    for (let i = 1; i < sortedDays.length; i++) {
      const [date, curr] = sortedDays[i];
      const [, prev] = sortedDays[i - 1];

      const totalDelta = (curr.total_fees - prev.total_fees) / MICRO_USD_DIVISOR;
      const spotProtocolDelta = (curr.total_spot_fees - prev.total_spot_fees) / MICRO_USD_DIVISOR;
      const perp = Math.max(0, totalDelta - spotProtocolDelta);
      const spot = Math.max(0, spotProtocolDelta * SPOT_DEPLOYER_MULTIPLIER);

      out.set(date, { perp, spot });
    }

    return out;
  }

  /**
   * Bucket /pastAuctions by UTC day. `deployGas` is the USDC paid by the
   * auction winner (stored negative — debit on the deployer side). We take
   * `abs()` and sum per day. `time` is in milliseconds.
   */
  private bucketHip1ByDay(auctions: AuctionInfo[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of auctions) {
      const amount = Math.abs(parseFloat(a.deployGas));
      if (!Number.isFinite(amount) || amount === 0) continue;
      const key = msToDateKey(a.time);
      out.set(key, (out.get(key) ?? 0) + amount);
    }
    return out;
  }

  /**
   * Bucket HIP-4 daily fees (`/hip4/analytics?interval=1d`). The bucket
   * timestamp is ISO without a Z suffix — it's already UTC per upstream, so
   * we append Z explicitly to avoid local-time drift.
   *
   * HIP-4 `#` markets currently have fee=0 by spec (SetOutcomeFeeScale
   * governance not activated), but `@` outcome-token fills do incur normal
   * spot fees and surface here as fees_usdc. Anything > 0 is real revenue.
   */
  private bucketHip4ByDay(rows: Hip4AnalyticsBucket[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of rows) {
      const fees = typeof r.fees_usdc === 'number' ? r.fees_usdc : Number(r.fees_usdc ?? 0);
      if (!Number.isFinite(fees) || fees === 0) continue;
      const iso = r.bucket?.endsWith('Z') ? r.bucket : `${r.bucket}Z`;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) continue;
      const key = msToDateKey(ms);
      out.set(key, (out.get(key) ?? 0) + fees);
    }
    return out;
  }

  /**
   * Bucket HIP-3 closed auctions by UTC day, converting HYPE → USD with the
   * current HYPE price. V1 simplification: same price for all days (HIP-3
   * represents <0.5% of total revenue so the error is negligible).
   */
  private bucketHip3ByDay(rows: Hip3AuctionRow[], hypeUsd: number | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!hypeUsd || hypeUsd <= 0) return out;

    for (const r of rows) {
      if (r.status !== 'closed') continue;
      const px = typeof r.cleared_px === 'number' ? r.cleared_px : Number(r.cleared_px);
      if (!Number.isFinite(px) || px <= 0) continue;
      const key = isoToDateKey(r.time);
      const usd = px * hypeUsd;
      out.set(key, (out.get(key) ?? 0) + usd);
    }
    return out;
  }

  private computeLifetime(days: RevenueDay[]): RevenueLifetime {
    const lifetime: RevenueLifetime = { perp: 0, spot: 0, hip1: 0, hip3: 0, hip4: 0, priority: 0, total: 0 };
    for (const d of days) {
      lifetime.perp += d.perp;
      lifetime.spot += d.spot;
      lifetime.hip1 += d.hip1;
      lifetime.hip3 += d.hip3;
      lifetime.hip4 += d.hip4;
      lifetime.priority += d.priority;
      lifetime.total += d.total;
    }
    return lifetime;
  }

  /**
   * Bucket HyperEVM priority fees by UTC day. `totalGas` is in HYPE — the
   * amount burned that day. We multiply by the current HYPE price (same V1
   * approximation as HIP-3 since priority fees are <0.5% of total revenue).
   */
  private bucketPriorityByDay(rows: PriorityFeeRow[], hypeUsd: number | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!hypeUsd || hypeUsd <= 0) return out;
    for (const r of rows) {
      if (!r.date) continue;
      const hype = typeof r.totalGas === 'number' ? r.totalGas : Number(r.totalGas);
      if (!Number.isFinite(hype) || hype <= 0) continue;
      out.set(r.date, hype * hypeUsd);
    }
    return out;
  }

  private sliceByWindow(days: RevenueDay[], window: RevenueWindow): RevenueDay[] {
    if (window === 'all') return days;
    const n = WINDOW_DAYS[window];
    return days.slice(-n);
  }

  /**
   * Fetch HIP-4 daily fee buckets with a 30 min local cache. Pulls the longest
   * usable 1d series in a single call (upstream `/hip4/analytics` caps `limit`
   * at 2000 — well beyond a year of daily buckets).
   */
  private async fetchHip4DailyFeesCached(): Promise<Hip4AnalyticsBucket[]> {
    const cached = await redisService.get(HIP4_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as Hip4AnalyticsBucket[];
      } catch {
        // fall through to refresh
      }
    }

    const raw = await this.hip4Client.getAnalytics<unknown>({ interval: '1d', limit: 2000 });
    const rows: Hip4AnalyticsBucket[] = Array.isArray(raw)
      ? (raw as Hip4AnalyticsBucket[])
      : Array.isArray((raw as Hip4AnalyticsResponse)?.data)
        ? (raw as Hip4AnalyticsResponse).data!
        : [];

    await redisService.set(HIP4_CACHE_KEY, JSON.stringify(rows), HIP4_CACHE_TTL_SECONDS);
    return rows;
  }

  /**
   * Fetch HIP-3 auctions history with a 30 min local cache. The Hip3 client
   * itself is unwrapped and stateless — we own the cache key here so the
   * RevenueService can run without coupling its TTL to the upstream client.
   */
  private async fetchHip3AuctionsCached(): Promise<Hip3AuctionRow[]> {
    const cached = await redisService.get(HIP3_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as Hip3AuctionRow[];
      } catch {
        // fall through to refresh
      }
    }

    const raw = await this.hip3Client.getAuctionsHistory({ limit: 500 }) as Hip3HistoryResponse | Hip3AuctionRow[];
    const rows: Hip3AuctionRow[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data) ? raw.data : [];

    await redisService.set(HIP3_CACHE_KEY, JSON.stringify(rows), HIP3_CACHE_TTL_SECONDS);
    return rows;
  }

  /** Read HYPE midPx from the perp markets cache. Returns null if absent. */
  private async readHypeUsd(): Promise<number | null> {
    try {
      const raw = await redisService.get(PERP_MARKETS_CACHE_KEY);
      if (!raw) return null;
      const markets = JSON.parse(raw) as PerpMarketLite[];
      const hype = markets.find((m) => m?.name === 'HYPE');
      if (!hype) return null;
      const px = Number(hype.price);
      return Number.isFinite(px) && px > 0 ? px : null;
    } catch (e) {
      logDeduplicator.warn('Failed to read HYPE price from perp:markets cache', {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private hip3Status(
    hip3Result: PromiseSettledResult<Hip3AuctionRow[]>,
    hypeUsd: number | null,
  ): RevenueSourceStatus {
    if (hip3Result.status !== 'fulfilled') return 'error';
    if (hypeUsd === null) return 'stale';
    return 'ok';
  }

  /**
   * Fetch the 42-day priority fees daily chart from HypeDexer with a 30 min
   * Redis cache (the upstream endpoint is rate-limited at ~10/req-weight).
   */
  private async fetchPriorityFeesCached(): Promise<PriorityFeeRow[]> {
    const cached = await redisService.get(PRIORITY_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as PriorityFeeRow[];
      } catch {
        // fall through to refresh
      }
    }

    const raw = await this.analyticsClient.getPriorityFeesChartDaily() as PriorityFeeResponse | PriorityFeeRow[];
    const rows: PriorityFeeRow[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data) ? raw.data : [];

    await redisService.set(PRIORITY_CACHE_KEY, JSON.stringify(rows), PRIORITY_CACHE_TTL_SECONDS);
    return rows;
  }

  private priorityStatus(
    priorityResult: PromiseSettledResult<PriorityFeeRow[]>,
    hypeUsd: number | null,
  ): RevenueSourceStatus {
    if (priorityResult.status !== 'fulfilled') return 'error';
    if (hypeUsd === null) return 'stale';
    return 'ok';
  }
}
