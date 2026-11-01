import { redisService } from '../../../core/redis.service';
import { withDistributedLock } from '../../../utils/distributedLock';
import { positiveIntEnv } from '../../../utils/env';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { runDbSync } from './hypurr-sync.apply';
import { summarizeDiff } from './hypurr-sync.report';
import { scrapeHypurrEcosystem } from './hypurr.scraper';

const LOCK_KEY = 'poll:hypurr-sync';
const LOCK_TTL_S = 900;
const LAST_RUN_KEY = 'hypurr-sync:last-run-at';
/** How often the timer wakes up to check whether a run is due. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000;

/**
 * Scheduled Hypurr Collective ecosystem sync (content DB projects directory).
 *
 * OFF by default. Env switches:
 * - HYPURR_SYNC_ENABLED=true     start the schedule (anything else: no timer at all)
 * - HYPURR_SYNC_APPLY=true       write to the DB; otherwise each run only logs the diff summary
 * - HYPURR_SYNC_INTERVAL_DAYS=7  minimum days between runs (last run kept in Redis, so
 *                                redeploys do not re-trigger it)
 * - HYPURR_SYNC_MAX_CREATES=50   safety cap on projects created per run
 * Runs under a Redis lock, so only one instance syncs.
 */
export class HypurrSyncService {
  private static instance: HypurrSyncService;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  public static getInstance(): HypurrSyncService {
    if (!HypurrSyncService.instance) {
      HypurrSyncService.instance = new HypurrSyncService();
    }
    return HypurrSyncService.instance;
  }

  public static isEnabled(): boolean {
    return process.env.HYPURR_SYNC_ENABLED?.trim().toLowerCase() === 'true';
  }

  public startPolling(): void {
    if (!HypurrSyncService.isEnabled()) {
      logDeduplicator.info('Hypurr ecosystem sync disabled (set HYPURR_SYNC_ENABLED=true to enable)');
      return;
    }
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(FIRST_CHECK_DELAY_MS);
  }

  public stopPolling(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async isDue(): Promise<boolean> {
    const everyMs = positiveIntEnv('HYPURR_SYNC_INTERVAL_DAYS', 7) * 86_400_000;
    const at = Number(await redisService.get(LAST_RUN_KEY).catch(() => null));
    return !Number.isFinite(at) || at <= 0 || Date.now() - at >= everyMs;
  }

  private async tick(): Promise<void> {
    try {
      if (await this.isDue()) {
        const ran = await withDistributedLock(LOCK_KEY, LOCK_TTL_S, () => this.runOnce());
        if (!ran) logDeduplicator.info('Hypurr sync skipped - another instance holds the lock');
      }
    } catch (err) {
      logDeduplicator.error('Hypurr sync failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.schedule(CHECK_INTERVAL_MS);
  }

  /** One sync run. Dry run unless HYPURR_SYNC_APPLY=true. */
  public async runOnce(): Promise<void> {
    const apply = process.env.HYPURR_SYNC_APPLY?.trim().toLowerCase() === 'true';
    const scrape = await scrapeHypurrEcosystem();
    if (scrape.warnings.length > 0) logDeduplicator.warn('Hypurr sync scrape warnings', { warnings: scrape.warnings });

    const maxCreates = positiveIntEnv('HYPURR_SYNC_MAX_CREATES', 50);
    const { diff, result } = await runDbSync(scrape.projects, { maxCreates, rehostLogos: true, dryRun: !apply });

    await redisService.set(LAST_RUN_KEY, String(Date.now()), 60 * 86_400).catch(() => undefined);
    logDeduplicator.info(`Hypurr sync ${apply ? 'applied' : 'dry run'}`, {
      ...summarizeDiff(diff),
      created: result.created.length,
      filled: result.filled.length,
      categoriesCreated: result.categoriesCreated,
      failures: result.failures.length,
      missingNames: diff.missing.map((m) => m.name).slice(0, 50),
    });
  }
}
