import { HyperliquidAssetCtxWSClient, CtxMarket } from './websocket/asset-ctx.ws.client';
import { logDeduplicator } from '../../utils/logDeduplicator';

/** A market is flushed from the stream's latest contexts this often (when it changed). */
export const CTX_FLUSH_INTERVAL_MS = 2_000;
/** REST read (meta + every context) while the stream is healthy: the reconciliation. */
export const CTX_REST_HEALTHY_MS = 60_000;
/** REST read while the stream is not healthy: the fallback. */
export const CTX_REST_UNHEALTHY_MS = 20_000;
/** Today's cadence, and the one kept when the stream is switched off. */
export const CTX_REST_ONLY_MS = 10_000;

/**
 * `HL_CTX_STREAM_ENABLED=false` keeps the pollers as they were: one REST read
 * every 10 s, no socket. Any other value (or none) turns the stream on.
 */
export function isCtxStreamEnabled(): boolean {
  return process.env.HL_CTX_STREAM_ENABLED !== 'false';
}

/** A REST read this old (the stream healthy, REST failing) leaves the meta and the new listings stale. */
export const CTX_REST_STALE_MS = 5 * 60_000;

/**
 * What a poller does on each 2 s tick while the stream is on:
 * - a REST read when one is due (every 60 s while the stream is healthy, every
 *   20 s while it is not), started without being awaited and never twice at
 *   once: a slow read (30 s timeout, retries, breaker) must not hold back the
 *   flushes;
 * - a flush of the stream's latest contexts if the market changed.
 * Health transitions are logged once each, and so is a REST read that has been
 * failing for over 5 minutes.
 */
export class CtxCadence {
  private lastRestAttemptAt = 0;
  private restInFlight = false;
  private lastRestOkAt: number;
  private staleWarned = false;
  private healthy: boolean | null = null;

  constructor(
    private readonly market: CtxMarket,
    private readonly label: string,
    private readonly stream: HyperliquidAssetCtxWSClient = HyperliquidAssetCtxWSClient.getInstance(),
    now: number = Date.now()
  ) {
    this.lastRestOkAt = now;
  }

  /**
   * One tick. `runRest` is started (not awaited) when due and none is in
   * flight; `runFlush` is awaited when the market changed. A REST read counts
   * from its attempt, not from its success: a refused read (429, breaker open)
   * is not hammered every 2 s. The poller reports a good read with `restSucceeded`.
   */
  public async tick(
    runRest: () => Promise<void>,
    runFlush: () => Promise<void>,
    now: number = Date.now()
  ): Promise<void> {
    const healthy = this.stream.isHealthy(this.market, now);
    this.logTransition(healthy);
    this.warnIfStale(now);

    const every = healthy ? CTX_REST_HEALTHY_MS : CTX_REST_UNHEALTHY_MS;
    if (!this.restInFlight && now - this.lastRestAttemptAt >= every) {
      this.lastRestAttemptAt = now;
      this.restInFlight = true;
      runRest()
        .catch((error) =>
          logDeduplicator.error(`${this.label}: asset-context REST read failed`, {
            error: error instanceof Error ? error.message : String(error),
          })
        )
        .finally(() => {
          this.restInFlight = false;
        });
    }

    if (this.stream.consumeDirty(this.market)) await runFlush();
  }

  /** A REST read came back: the meta is fresh again. */
  public restSucceeded(now: number = Date.now()): void {
    this.lastRestOkAt = now;
    this.staleWarned = false;
  }

  private warnIfStale(now: number): void {
    if (this.staleWarned || now - this.lastRestOkAt <= CTX_REST_STALE_MS) return;
    this.staleWarned = true;
    logDeduplicator.warn(
      `${this.label}: no successful REST read for over ${CTX_REST_STALE_MS / 60_000} minutes, the meta and new listings are stale`,
      { sinceLastSuccessMs: now - this.lastRestOkAt, streamHealthy: this.healthy === true }
    );
  }

  public isHealthy(): boolean {
    return this.healthy === true;
  }

  private logTransition(healthy: boolean): void {
    if (this.healthy === healthy) return;
    const was = this.healthy;
    this.healthy = healthy;
    const stats = this.stream.getStats();
    if (healthy) {
      logDeduplicator.info(`${this.label}: asset-context stream healthy, REST reconciles every ${CTX_REST_HEALTHY_MS / 1000} s`, { ...stats });
    } else if (was === null) {
      logDeduplicator.info(`${this.label}: asset-context stream not up yet, REST every ${CTX_REST_UNHEALTHY_MS / 1000} s`, { ...stats });
    } else {
      logDeduplicator.warn(`${this.label}: asset-context stream not healthy, REST every ${CTX_REST_UNHEALTHY_MS / 1000} s`, { ...stats });
    }
  }
}
