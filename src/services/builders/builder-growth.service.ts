import { decompress } from 'lz4js';
import { prismaHistorical } from '../../core/prisma.historical.service';
import { cacheService } from '../../core/cache.service';
import { redisService } from '../../core/redis.service';
import { withDistributedLock } from '../../utils/distributedLock';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HypeDexerBuildersIndexerClient } from '../../clients/hypedexer/rest/builders/builders-indexer.client';
import {
  addDays,
  aggregateCsv,
  BUILDER_FILLS_GENESIS,
  daysBetween,
  fileUrl,
  isoDay,
  lastPublishedDay,
  parseDay,
} from './builder-growth.util';

export type GrowthMetric = 'fees' | 'users' | 'newUsers' | 'volume';
export type GrowthRange = '30d' | '90d' | '180d' | 'all';

export interface GrowthBuilder {
  address: string;
  name: string | null;
  /** Sum of the metric over the range (for users: sum of daily users). */
  total: number;
  /** One value per entry of `days`. */
  series: number[];
}

export interface GrowthSnapshot {
  metric: GrowthMetric;
  range: GrowthRange;
  days: string[];
  builders: GrowthBuilder[];
  coverage: {
    tracked: number;
    /** Builders whose history is still being ingested. */
    backfilling: number;
    lastDay: string | null;
  };
  computedAt: string;
}

const LOCK_KEY = 'poll:builder-growth';
const LOCK_TTL_S = 330;
/** Work budget per tick so the lock never outlives its TTL. */
const TICK_BUDGET_MS = 270_000;
const TICK_INTERVAL_MS = 5 * 60_000;
/** Gap between ticks while history is still being ingested. */
const BACKFILL_INTERVAL_MS = 30_000;
/** Builders ingested in parallel; each one walks its days in order. */
const INGEST_CONCURRENCY = 4;
const DISCOVERY_CONCURRENCY = 32;
const FETCH_TIMEOUT_MS = 60_000;

/** Builders kept from the historical sample (catches past leaders). */
const TRACK_TOP_HISTORIC = 30;
/** Builders kept from the current 30-day leaderboard by builder fees. */
const TRACK_TOP_CURRENT = 25;
const DISCOVERY_KEY = 'builder-growth:discovered-at';
const DISCOVERY_EVERY_S = 7 * 86_400;
const CURRENT_TOP_KEY = 'builder-growth:current-top-at';
const CURRENT_TOP_EVERY_S = 86_400;

const SNAPSHOT_FRESH_S = 600;
const SNAPSHOT_KEEP_S = 86_400;
const RANGE_DAYS: Record<Exclude<GrowthRange, 'all'>, number> = { '30d': 30, '90d': 90, '180d': 180 };

interface RegistryRow {
  address: string;
  name: string | null;
}

function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const k of ['data', 'builders', 'items']) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function readRegistryRow(raw: unknown, addressKey: string, nameKey: string): RegistryRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const address = typeof r[addressKey] === 'string' ? (r[addressKey] as string).toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  const name = typeof r[nameKey] === 'string' && (r[nameKey] as string).trim() ? (r[nameKey] as string).trim() : null;
  return { address, name };
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Builder code growth.
 *
 * Hyperliquid publishes one file per builder and per day with every fill that
 * carried the builder's code. This service picks the builders worth charting
 * (past and current leaders), ingests their files day by day into the
 * historical DB (daily revenue, volume, users, new users), and serves the
 * per-builder daily series. The backfill runs in the background in bounded
 * ticks, then one new day per builder lands each morning.
 */
export class BuilderGrowthService {
  private static instance: BuilderGrowthService;

  private readonly builders = HypeDexerBuildersIndexerClient.getInstance();
  private pollingTimeout: NodeJS.Timeout | null = null;
  private pollingStopped = true;
  private backlog = false;

  public static getInstance(): BuilderGrowthService {
    if (!BuilderGrowthService.instance) {
      BuilderGrowthService.instance = new BuilderGrowthService();
    }
    return BuilderGrowthService.instance;
  }

  public startPolling(): void {
    if (process.env.BUILDER_GROWTH_ENABLED === 'false') {
      logDeduplicator.info('Builder growth ingestion disabled (BUILDER_GROWTH_ENABLED=false)');
      return;
    }
    if (!this.pollingStopped) return;
    this.pollingStopped = false;
    // Let the server settle before the first (possibly long) tick.
    this.pollingTimeout = setTimeout(() => void this.tick(), 60_000);
  }

  public stopPolling(): void {
    this.pollingStopped = true;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.pollingStopped) return;
    try {
      const ran = await withDistributedLock(LOCK_KEY, LOCK_TTL_S, () => this.runOnce());
      if (!ran) logDeduplicator.info('Builder growth tick skipped - another instance holds the lock');
    } catch (err) {
      logDeduplicator.error('Builder growth tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (this.pollingStopped) return;
    this.pollingTimeout = setTimeout(() => void this.tick(), this.backlog ? BACKFILL_INTERVAL_MS : TICK_INTERVAL_MS);
  }

  /** One bounded unit of work: refresh the tracked set when due, then ingest. */
  public async runOnce(): Promise<void> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    await this.refreshTracked();
    this.backlog = await this.ingest(deadline);
  }

  // --------------------------------------------------------------------------
  // Which builders to track
  // --------------------------------------------------------------------------

  private async isDue(key: string, everyS: number): Promise<boolean> {
    const at = Number(await redisService.get(key).catch(() => null));
    return !Number.isFinite(at) || at <= 0 || Date.now() - at > everyS * 1000;
  }

  private async markDone(key: string, everyS: number): Promise<void> {
    await redisService.set(key, String(Date.now()), everyS * 2).catch(() => undefined);
  }

  private async refreshTracked(): Promise<void> {
    const tracked = await prismaHistorical.builderTracked.count();
    if (tracked === 0 || (await this.isDue(DISCOVERY_KEY, DISCOVERY_EVERY_S))) {
      await this.discover();
      await this.markDone(DISCOVERY_KEY, DISCOVERY_EVERY_S);
      await this.markDone(CURRENT_TOP_KEY, CURRENT_TOP_EVERY_S);
    } else if (await this.isDue(CURRENT_TOP_KEY, CURRENT_TOP_EVERY_S)) {
      await this.addCurrentLeaders(new Map());
      await this.markDone(CURRENT_TOP_KEY, CURRENT_TOP_EVERY_S);
    }
  }

  /**
   * Sample every registered builder on the 15th of every other month (HEAD requests:
   * the compressed size of a day file tracks its activity) and keep the
   * builders with the largest sampled total, plus the current leaders.
   */
  private async discover(): Promise<void> {
    const registry = asArray(await this.builders.listBuilders())
      .map((r) => readRegistryRow(r, 'address', 'name'))
      .filter((r): r is RegistryRow => r !== null);
    const names = new Map(registry.map((r) => [r.address, r.name]));

    const last = lastPublishedDay();
    const sampleDays: string[] = [];
    for (let d = '2024-11-15'; d <= last; d = isoDay(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) + 1, 15)))) {
      sampleDays.push(d);
    }
    sampleDays.push(last);

    const scores = new Map<string, number>();
    const probes = registry.flatMap((r) => sampleDays.map((day) => ({ address: r.address, day })));
    await pool(probes, DISCOVERY_CONCURRENCY, async ({ address, day }) => {
      try {
        const res = await fetch(fileUrl(address, day), { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return;
        const size = Number(res.headers.get('content-length') ?? 0);
        if (size > 0) scores.set(address, (scores.get(address) ?? 0) + size);
      } catch {
        // A failed probe only lowers this builder's sampled score.
      }
    });

    const historic = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, TRACK_TOP_HISTORIC);
    for (const [address, score] of historic) {
      await prismaHistorical.builderTracked.upsert({
        where: { address },
        create: { address, name: names.get(address) ?? null, score: BigInt(score) },
        update: { name: names.get(address) ?? undefined, score: BigInt(score) },
      });
    }
    await this.addCurrentLeaders(names);
    logDeduplicator.info('Builder growth discovery done', {
      registry: registry.length,
      probes: probes.length,
      active: scores.size,
      kept: historic.length,
    });
  }

  /** Add the current 30-day leaders by builder fees (new builders show up here first). */
  private async addCurrentLeaders(names: Map<string, string | null>): Promise<void> {
    const top = asArray(await this.builders.getTopBuilders({ timeframe: '30d', sort: 'builder_fees', limit: TRACK_TOP_CURRENT }))
      .map((r) => readRegistryRow(r, 'builder', 'builderName'))
      .filter((r): r is RegistryRow => r !== null);
    for (const r of top) {
      const name = r.name ?? names.get(r.address) ?? null;
      await prismaHistorical.builderTracked.upsert({
        where: { address: r.address },
        create: { address: r.address, name },
        update: name ? { name } : {},
      });
    }
  }

  // --------------------------------------------------------------------------
  // Ingestion
  // --------------------------------------------------------------------------

  /** Returns true when days are still left to ingest after this tick. */
  private async ingest(deadline: number): Promise<boolean> {
    const last = lastPublishedDay();
    const lastDate = parseDay(last);
    const pending = await prismaHistorical.builderTracked.findMany({
      where: { OR: [{ cursor: null }, { cursor: { lt: lastDate } }] },
      orderBy: [{ cursor: { sort: 'asc', nulls: 'first' } }, { score: 'desc' }],
    });
    if (pending.length === 0) return false;

    let files = 0;
    await pool(pending, INGEST_CONCURRENCY, async (b) => {
      let day = b.cursor ? addDays(isoDay(b.cursor), 1) : BUILDER_FILLS_GENESIS;
      try {
        while (day <= last && Date.now() < deadline) {
          await this.ingestDay(b.id, b.address, day);
          await prismaHistorical.builderTracked.update({
            where: { id: b.id },
            data: { cursor: parseDay(day), backfillDone: day >= addDays(last, -1), lastError: null },
          });
          files += 1;
          day = addDays(day, 1);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await prismaHistorical.builderTracked
          .update({ where: { id: b.id }, data: { lastError: `${day}: ${message}`.slice(0, 1000) } })
          .catch(() => undefined);
        logDeduplicator.warn('Builder growth: day ingest failed, retried next tick', { builder: b.address, day, error: message });
      }
    });
    if (files > 0) {
      await cacheService.invalidateByPattern('builder-growth:snapshot:*').catch(() => undefined);
      logDeduplicator.info('Builder growth ingest tick', { builders: pending.length, files, last });
    }
    return Date.now() >= deadline;
  }

  /** Fetch, aggregate and store one builder-day. A missing file means no fills that day. */
  private async ingestDay(builderId: number, address: string, day: string): Promise<void> {
    const res = await fetch(fileUrl(address, day), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 403 || res.status === 404) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const csv = Buffer.from(decompress(new Uint8Array(await res.arrayBuffer()))).toString('utf8');
    const agg = aggregateCsv(csv);
    if (agg.fills === 0) return;

    const dayDate = parseDay(day);
    await prismaHistorical.$executeRaw`
      INSERT INTO builder_user (builder_id, user_key, first_day)
      SELECT ${builderId}::int, k, ${day}::date FROM unnest(${agg.users}::text[]::bigint[]) AS u(k)
      ON CONFLICT (builder_id, user_key) DO UPDATE
        SET first_day = LEAST(builder_user.first_day, EXCLUDED.first_day)`;
    const [{ n }] = await prismaHistorical.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM builder_user WHERE builder_id = ${builderId} AND first_day = ${day}::date`;

    const row = {
      fees: agg.fees.toFixed(6),
      volume: agg.volume.toFixed(2),
      fills: agg.fills,
      users: agg.users.length,
      newUsers: n,
    };
    await prismaHistorical.builderDaily.upsert({
      where: { builderId_day: { builderId, day: dayDate } },
      create: { builderId, day: dayDate, ...row },
      update: row,
    });
  }

  // --------------------------------------------------------------------------
  // Read side
  // --------------------------------------------------------------------------

  public async getGrowth(metric: GrowthMetric, range: GrowthRange): Promise<GrowthSnapshot> {
    return cacheService.getOrRefresh(
      `builder-growth:snapshot:${metric}:${range}`,
      () => this.computeGrowth(metric, range),
      SNAPSHOT_FRESH_S,
      SNAPSHOT_KEEP_S
    );
  }

  private async computeGrowth(metric: GrowthMetric, range: GrowthRange): Promise<GrowthSnapshot> {
    const tracked = await prismaHistorical.builderTracked.findMany({
      select: { id: true, address: true, name: true, backfillDone: true, cursor: true },
    });
    // The window always ends on the last published day, so a partial backfill
    // shows as missing history rather than as a window stuck in the past.
    const end = lastPublishedDay();
    const lastDay = tracked.some((t) => t.cursor && isoDay(t.cursor) >= end) ? end : null;
    const start = range === 'all' ? BUILDER_FILLS_GENESIS : addDays(end, -(RANGE_DAYS[range] - 1));
    const days = daysBetween(start, end);
    const index = new Map(days.map((d, i) => [d, i]));

    const rows = await prismaHistorical.builderDaily.findMany({
      where: { day: { gte: parseDay(start), lte: parseDay(end) } },
      select: { builderId: true, day: true, fees: true, volume: true, users: true, newUsers: true },
    });

    const byId = new Map<number, number[]>();
    for (const r of rows) {
      const i = index.get(isoDay(r.day));
      if (i === undefined) continue;
      let series = byId.get(r.builderId);
      if (!series) {
        series = new Array<number>(days.length).fill(0);
        byId.set(r.builderId, series);
      }
      series[i] =
        metric === 'fees' ? Number(r.fees) : metric === 'volume' ? Number(r.volume) : metric === 'users' ? r.users : r.newUsers;
    }

    const builders: GrowthBuilder[] = tracked
      .filter((b) => byId.has(b.id))
      .map((b) => {
        const series = byId.get(b.id) as number[];
        return { address: b.address, name: b.name, total: series.reduce((s, v) => s + v, 0), series };
      })
      .filter((b) => b.total > 0)
      .sort((a, b) => b.total - a.total);

    return {
      metric,
      range,
      days,
      builders,
      coverage: {
        tracked: tracked.length,
        backfilling: tracked.filter((b) => !b.backfillDone).length,
        lastDay,
      },
      computedAt: new Date().toISOString(),
    };
  }
}
