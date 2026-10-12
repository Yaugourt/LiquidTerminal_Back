import { HypeDexerElysiumIndexerClient } from '../../clients/hypedexer/rest/elysium/elysium-indexer.client';
import type {
  ElysiumIngestPageQuery,
  ElysiumIngestPath,
} from '../../clients/hypedexer/rest/elysium/elysium-indexer.client';
import { withDistributedLock } from '../../utils/distributedLock';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { rawLogger } from '../../utils/logger';
import { ElysiumIngestRepository, ElysiumStream } from '../../repositories/prisma/prisma.elysium.repository';
import {
  dedupeBy,
  ELYSIUM_GENESIS,
  HOUR_MS,
  MINUTE_MS,
  normalizeBridgeTransfer,
  normalizeToken,
  normalizeTx,
  planWindow,
  toUpstreamTime,
  BridgeRow,
  TokenRow,
  TxRow,
  scaleRawAmount,
} from './elysium-ingest.util';
import {
  decodePoolCreated,
  decodeSwap,
  DEX_TOPICS,
  pickSignature,
  DexPoolRow,
  DexSwapRow,
} from './elysium-dex.util';
import {
  CHAINZY_CREATOR_LOCKER,
  decodeGraduation,
  decodeLaunch,
  decodeLaunchTrade,
  GRADUATION_TOPICS,
  LAUNCH_TOPIC_ORDER,
  launchMarketKeys,
  LaunchMarket,
  LaunchRow,
  LaunchTradeRow,
  Launchpad,
  TRADE_TOPICS,
  V4_POOL_MANAGERS,
} from './elysium-launchpad.util';

const PAGE_SIZE = 1000;
/** Hard stop per window: 200k rows/hour is ~20x the measured peak. */
const MAX_PAGES_PER_WINDOW = 200;
/** Smallest tx window the stream shrinks to when a window overflows the page cap. */
const TX_MIN_STEP_MS = 60_000;

class PageCapError extends Error {
  constructor() {
    super('Elysium ingest: window exceeded the page cap');
    this.name = 'PageCapError';
  }
}
/** At most ~2 upstream calls per second across every stream. */
const MIN_CALL_GAP_MS = 500;
/** Work budget per tick so a lock never outlives its TTL. */
const TICK_BUDGET_MS = 40_000;
const LOCK_TTL_S = 120;

const TX_LIVE_INTERVAL_MS = 30_000;
const TX_STEP_MS = HOUR_MS;
const TX_OVERLAP_MS = 120_000;
const TX_SETTLE_MS = 15_000;

const BRIDGE_LIVE_INTERVAL_MS = 60_000;
const BRIDGE_LIVE_WINDOW_MS = 15 * MINUTE_MS;
const BRIDGE_WIDE_EVERY_MS = 15 * MINUTE_MS;
const BRIDGE_WIDE_WINDOW_MS = 26 * HOUR_MS;
/** Withdrawals settle on HyperEVM after hours to days; sweep executed ones over 8d. */
const BRIDGE_EXECUTED_SWEEP_MS = 8 * 24 * HOUR_MS;
const BRIDGE_BACKFILL_STEP_MS = 6 * HOUR_MS;

const TOKENS_INTERVAL_MS = 15 * MINUTE_MS;

const DEX_LIVE_INTERVAL_MS = 60_000;
/** DEX logs are sparse on testnet: one day per backfill window is plenty. */
const DEX_STEP_MS = 24 * HOUR_MS;
const DEX_OVERLAP_MS = 120_000;
const DEX_SETTLE_MS = 15_000;

const METHODS_INTERVAL_MS = 30 * MINUTE_MS;
/** Only the most frequent selectors are resolved. */
const METHODS_TOP_N = 200;
/** A selector with no known signature is looked up again after a day. */
const METHODS_RETRY_S = 24 * 3600;
const METHODS_BATCH = 50;
const SIGNATURE_DB_URL = 'https://api.openchain.xyz/signature-database/v1/lookup';
/** Fallback when the primary database is down (one selector per call). */
const FOURBYTE_URL = 'https://www.4byte.directory/api/v1/signatures/';

const TOKEN_STATS_INTERVAL_MS = 15 * MINUTE_MS;

const LAUNCHPAD_LIVE_INTERVAL_MS = 30_000;
const LAUNCHPAD_STEP_MS = 24 * HOUR_MS;
const LAUNCHPAD_OVERLAP_MS = 120_000;
const LAUNCHPAD_SETTLE_MS = 15_000;

const LAUNCH_STATS_INTERVAL_MS = 5 * MINUTE_MS;
const LAUNCH_STATS_MAX_AGE_S = 14 * 60;
const LAUNCH_STATS_BATCH = 60;
/** Holder page size: launch tokens have far fewer holders, a full page falls back to the detail count. */
const LAUNCH_HOLDERS_LIMIT = 1000;
/** Holder snapshots for the top N tokens of each ranked list only. */
const TOKEN_STATS_TOP_N = 25;
const TOKEN_STATS_MAX_AGE_S = 14 * 60;

/** Serialises upstream calls with a minimum gap (shared by all streams). */
class CallThrottle {
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();

  public wait(): Promise<void> {
    const turn = this.chain.then(async () => {
      const delay = this.nextAt - Date.now();
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      this.nextAt = Date.now() + MIN_CALL_GAP_MS;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}

class IngestStoppedError extends Error {
  constructor() {
    super('Elysium ingestion stopped');
    this.name = 'IngestStoppedError';
  }
}

/**
 * Elysium ingestion: pulls raw txs, bridge transfers and the token registry
 * from the provider's REST API into the historical DB.
 *
 * - tx: walks from genesis in 1h windows (backfill), then every 30s re-reads
 *   [cursor - 120s, now - 15s]. System txs are skipped, spam is kept + flagged.
 * - bridge: one-time backfill from genesis, then last 15 min every 60s plus a
 *   26h window (status changes) and an executed-withdrawals sweep every 15 min.
 * - tokens: full ERC-20 listing every 15 min.
 * - dex: Uniswap V2/V3 pool-creation and swap logs (/logs by topic0), walked
 *   from genesis in 1-day windows, then every 60s like the tx stream.
 * - methods: resolves the top 200 called selectors via a public signature
 *   database every 30 min (cached permanently, misses retried daily).
 * - tokenstats: holder counts (/tokens/{address}) for the top tokens only.
 *
 * Each stream is a self-rescheduling loop (single flight by construction),
 * guarded by a Redis lock, and never throws: failures are recorded in
 * elysium_ingest_state.last_error and the stream backs off.
 */
export class ElysiumIngestionService {
  private static instance: ElysiumIngestionService;

  private readonly client = HypeDexerElysiumIndexerClient.getInstance();
  private readonly repo = ElysiumIngestRepository.getInstance();
  private readonly throttle = new CallThrottle();

  private stopped = true;
  private timers = new Map<ElysiumStream, NodeJS.Timeout>();
  private failures = new Map<ElysiumStream, number>();
  private lastBridgeWideAt = 0;
  private backfillWindows = 0;
  /** Current tx window length: halves on a page-cap overflow, grows back after. */
  private txStepMs = TX_STEP_MS;

  public static getInstance(): ElysiumIngestionService {
    if (!ElysiumIngestionService.instance) {
      ElysiumIngestionService.instance = new ElysiumIngestionService();
    }
    return ElysiumIngestionService.instance;
  }

  public static isEnabled(): boolean {
    return (process.env.ELYSIUM_INGEST_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  }

  public startPolling(): void {
    if (!ElysiumIngestionService.isEnabled()) {
      logDeduplicator.info('Elysium ingestion disabled by ELYSIUM_INGEST_ENABLED');
      return;
    }
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule('tx', 0, () => this.txTick());
    this.schedule('bridge', 5_000, () => this.bridgeTick());
    this.schedule('tokens', 10_000, () => this.tokensTick());
    this.schedule('dex', 15_000, () => this.dexTick());
    this.schedule('methods', 20_000, () => this.methodsTick());
    this.schedule('tokenstats', 90_000, () => this.tokenStatsTick());
    this.schedule('launchpad', 25_000, () => this.launchpadTick());
    this.schedule('launchstats', 120_000, () => this.launchStatsTick());
    logDeduplicator.info('Elysium ingestion started');
  }

  public stopPolling(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------------------------------------------------------------------------
  // Loop plumbing
  // ---------------------------------------------------------------------------

  /** Runs `tick` after `delayMs`; tick resolves to the delay until its next run. */
  private schedule(stream: ElysiumStream, delayMs: number, tick: () => Promise<number>): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.runTick(stream, tick).then((next) => this.schedule(stream, next, tick));
    }, delayMs);
    timer.unref?.();
    this.timers.set(stream, timer);
  }

  private async runTick(stream: ElysiumStream, tick: () => Promise<number>): Promise<number> {
    let next = 0;
    try {
      const ran = await withDistributedLock(`poll:elysium-ingest:${stream}`, LOCK_TTL_S, async () => {
        next = await tick();
      });
      if (!ran) next = this.baseInterval(stream);
      this.failures.set(stream, 0);
      return next;
    } catch (error) {
      if (error instanceof IngestStoppedError) return 0;
      const count = (this.failures.get(stream) ?? 0) + 1;
      this.failures.set(stream, count);
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.repo.recordError(stream, message);
      } catch {
        // DB unreachable: the warn below is the only trace, and that is fine.
      }
      logDeduplicator.warn('Elysium ingest: stream tick failed', {
        stream,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return this.baseInterval(stream) * Math.min(2 ** count, 10);
    }
  }

  private baseInterval(stream: ElysiumStream): number {
    if (stream === 'tx') return TX_LIVE_INTERVAL_MS;
    if (stream === 'bridge') return BRIDGE_LIVE_INTERVAL_MS;
    if (stream === 'dex') return DEX_LIVE_INTERVAL_MS;
    if (stream === 'methods') return METHODS_INTERVAL_MS;
    if (stream === 'tokenstats') return TOKEN_STATS_INTERVAL_MS;
    if (stream === 'launchpad') return LAUNCHPAD_LIVE_INTERVAL_MS;
    if (stream === 'launchstats') return LAUNCH_STATS_INTERVAL_MS;
    return TOKENS_INTERVAL_MS;
  }

  private ensureRunning(): void {
    if (this.stopped) throw new IngestStoppedError();
  }

  /**
   * Pages a list endpoint until a short page, handing each page to `onPage`.
   * At the page cap it throws PageCapError, or with `truncate` keeps what it
   * read and returns true: anyone can write to the testnet, so a window that
   * spam pushes past the cap must not stall a stream forever.
   */
  private async pageAll(
    path: ElysiumIngestPath,
    params: Record<string, string | boolean>,
    onPage: (rows: unknown[]) => Promise<void>,
    opts: { truncate?: boolean } = {}
  ): Promise<boolean> {
    for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
      this.ensureRunning();
      await this.throttle.wait();
      const query: ElysiumIngestPageQuery = { ...params, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
      const rows = await this.client.fetchIngestPage(path, query);
      await onPage(rows);
      if (rows.length < PAGE_SIZE) return false;
    }
    if (!opts.truncate) throw new PageCapError();
    logDeduplicator.warn('Elysium ingest: window truncated at the page cap', { path });
    return true;
  }

  // ---------------------------------------------------------------------------
  // tx stream
  // ---------------------------------------------------------------------------

  private async txTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const state = await this.repo.getState('tx');
    let cursor = state?.cursor ?? null;
    let backfillDone = state?.backfillDone ?? false;

    while (Date.now() < deadline) {
      this.ensureRunning();
      const w = planWindow({
        cursor,
        backfillDone,
        now: new Date(),
        genesis: ELYSIUM_GENESIS,
        stepMs: this.txStepMs,
        overlapMs: TX_OVERLAP_MS,
        settleMs: TX_SETTLE_MS,
      });
      if (!w) return TX_LIVE_INTERVAL_MS;

      let inserted = 0;
      try {
        await this.pageAll(
          '/transactions',
          {
            start_time: toUpstreamTime(w.start),
            end_time: toUpstreamTime(w.end),
            include_spam: true,
            include_system: false,
          },
          async (raw) => {
            const rows = dedupeBy(
              raw.map(normalizeTx).filter((r): r is TxRow => r !== null),
              (r) => r.tx_hash
            );
            inserted += (await this.repo.insertTxs(rows)).inserted;
          },
          // At the smallest step, keep what was read and move on.
          { truncate: this.txStepMs <= TX_MIN_STEP_MS }
        );
      } catch (error) {
        if (!(error instanceof PageCapError)) throw error;
        // Too many txs in this window (a spam burst): retry it in halves.
        this.txStepMs = Math.max(TX_MIN_STEP_MS, Math.floor(this.txStepMs / 2));
        continue;
      }
      // Window fit: grow back toward the normal step.
      this.txStepMs = Math.min(TX_STEP_MS, this.txStepMs * 2);

      const finishesBackfill = !backfillDone && w.caughtUp;
      await this.repo.advance('tx', {
        cursor: w.end,
        addRows: inserted,
        ...(finishesBackfill ? { backfillDone: true } : {}),
      });
      cursor = w.end;

      if (!backfillDone) {
        this.backfillWindows++;
        if (finishesBackfill) {
          backfillDone = true;
          void rawLogger.info('Elysium ingest: tx backfill complete');
        } else if (this.backfillWindows % 24 === 0) {
          void rawLogger.info('Elysium ingest: tx backfill progress', { cursor: w.end.toISOString() });
        }
      }
      if (w.caughtUp) return TX_LIVE_INTERVAL_MS;
    }
    // Budget spent but still behind: continue right away.
    return 0;
  }

  // ---------------------------------------------------------------------------
  // bridge stream
  // ---------------------------------------------------------------------------

  private async ingestBridgeWindow(params: Record<string, string>): Promise<number> {
    let changed = 0;
    await this.pageAll('/bridge/transfers', params, async (raw) => {
      const rows = dedupeBy(
        raw.map(normalizeBridgeTransfer).filter((r): r is BridgeRow => r !== null),
        (r) => r.transfer_id
      );
      changed += await this.repo.upsertBridgeTransfers(rows);
    }, { truncate: true });
    return changed;
  }

  private async bridgeTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const state = await this.repo.getState('bridge');

    if (!state?.backfillDone) {
      let cursor = state?.cursor ?? null;
      while (Date.now() < deadline) {
        this.ensureRunning();
        const w = planWindow({
          cursor,
          backfillDone: false,
          now: new Date(),
          genesis: ELYSIUM_GENESIS,
          stepMs: BRIDGE_BACKFILL_STEP_MS,
          overlapMs: 0,
          settleMs: 0,
        });
        if (!w) {
          await this.repo.advance('bridge', { addRows: 0, backfillDone: true });
          break;
        }
        const changed = await this.ingestBridgeWindow({
          start_time: toUpstreamTime(w.start),
          end_time: toUpstreamTime(w.end),
        });
        await this.repo.advance('bridge', {
          cursor: w.end,
          addRows: changed,
          ...(w.caughtUp ? { backfillDone: true } : {}),
        });
        cursor = w.end;
        if (w.caughtUp) {
          void rawLogger.info('Elysium ingest: bridge backfill complete');
          break;
        }
      }
      return state?.backfillDone ? BRIDGE_LIVE_INTERVAL_MS : 0;
    }

    const now = new Date();
    const wide = now.getTime() - this.lastBridgeWideAt >= BRIDGE_WIDE_EVERY_MS;
    const windowMs = wide ? BRIDGE_WIDE_WINDOW_MS : BRIDGE_LIVE_WINDOW_MS;
    let changed = await this.ingestBridgeWindow({
      start_time: toUpstreamTime(new Date(now.getTime() - windowMs)),
      end_time: toUpstreamTime(now),
    });
    if (wide) {
      changed += await this.ingestBridgeWindow({
        direction: 'withdrawal',
        status: 'executed',
        start_time: toUpstreamTime(new Date(now.getTime() - BRIDGE_EXECUTED_SWEEP_MS)),
        end_time: toUpstreamTime(now),
      });
      this.lastBridgeWideAt = now.getTime();
    }
    await this.repo.advance('bridge', { cursor: now, addRows: changed });
    return BRIDGE_LIVE_INTERVAL_MS;
  }

  // ---------------------------------------------------------------------------
  // tokens stream
  // ---------------------------------------------------------------------------

  private async tokensTick(): Promise<number> {
    let upserted = 0;
    await this.pageAll('/tokens', { standard: 'erc20' }, async (raw) => {
      const rows = dedupeBy(
        raw.map(normalizeToken).filter((r): r is TokenRow => r !== null),
        (r) => r.address
      );
      upserted += await this.repo.upsertTokens(rows);
    }, { truncate: true });
    // rows = size of the latest listing (a snapshot), not a running total.
    await this.repo.advance('tokens', { cursor: new Date(), setRows: upserted, backfillDone: true });
    return TOKENS_INTERVAL_MS;
  }

  // ---------------------------------------------------------------------------
  // dex stream
  // ---------------------------------------------------------------------------

  private async ingestDexWindow(start: Date, end: Date): Promise<number> {
    const time = { start_time: toUpstreamTime(start), end_time: toUpstreamTime(end) };
    let inserted = 0;
    for (const topic0 of [DEX_TOPICS.v2PairCreated, DEX_TOPICS.v3PoolCreated]) {
      await this.pageAll('/logs', { ...time, topic0 }, async (raw) => {
        const rows = dedupeBy(
          raw.map(decodePoolCreated).filter((r): r is DexPoolRow => r !== null),
          (r) => r.pool
        );
        inserted += await this.repo.insertDexPools(rows);
      }, { truncate: true });
    }
    for (const topic0 of [DEX_TOPICS.v2Swap, DEX_TOPICS.v3Swap]) {
      await this.pageAll('/logs', { ...time, topic0 }, async (raw) => {
        const rows = dedupeBy(
          raw.map(decodeSwap).filter((r): r is DexSwapRow => r !== null),
          (r) => `${r.tx_hash}:${r.log_index}`
        );
        inserted += await this.repo.insertDexSwaps(rows);
      }, { truncate: true });
    }
    return inserted;
  }

  private async dexTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const state = await this.repo.getState('dex');
    let cursor = state?.cursor ?? null;
    let backfillDone = state?.backfillDone ?? false;

    while (Date.now() < deadline) {
      this.ensureRunning();
      const w = planWindow({
        cursor,
        backfillDone,
        now: new Date(),
        genesis: ELYSIUM_GENESIS,
        stepMs: DEX_STEP_MS,
        overlapMs: DEX_OVERLAP_MS,
        settleMs: DEX_SETTLE_MS,
      });
      if (!w) return DEX_LIVE_INTERVAL_MS;
      const inserted = await this.ingestDexWindow(w.start, w.end);
      const finishesBackfill = !backfillDone && w.caughtUp;
      await this.repo.advance('dex', {
        cursor: w.end,
        addRows: inserted,
        ...(finishesBackfill ? { backfillDone: true } : {}),
      });
      cursor = w.end;
      if (finishesBackfill) {
        backfillDone = true;
        void rawLogger.info('Elysium ingest: dex backfill complete');
      }
      if (w.caughtUp) return DEX_LIVE_INTERVAL_MS;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // methods stream (selector -> signature, public signature database)
  // ---------------------------------------------------------------------------

  private async lookupSignatures(ids: string[]): Promise<Record<string, unknown>> {
    const url = `${SIGNATURE_DB_URL}?function=${ids.join(',')}&filter=true`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'liquidterminal-back' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Signature database HTTP ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; result?: { function?: Record<string, unknown> } };
    if (!body.ok || !body.result?.function) throw new Error('Signature database: unexpected payload');
    return body.result.function;
  }

  /** 4byte.directory: the earliest registered signature wins (collisions are later spam). */
  private async lookupFourByte(id: string): Promise<{ signature: string | null; candidates: number }> {
    const res = await fetch(`${FOURBYTE_URL}?hex_signature=${id}&ordering=created_at`, {
      headers: { Accept: 'application/json', 'User-Agent': 'liquidterminal-back' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`4byte HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ id?: unknown; text_signature?: unknown }> };
    const list = (body.results ?? []).filter(
      (r): r is { id: number; text_signature: string } =>
        typeof r.id === 'number' && typeof r.text_signature === 'string'
    );
    list.sort((a, b) => a.id - b.id);
    return { signature: list[0]?.text_signature ?? null, candidates: list.length };
  }

  private async methodsTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const ids = await this.repo.listUnresolvedMethods(METHODS_TOP_N, METHODS_RETRY_S);
    let written = 0;
    let primaryDown = false;
    for (let i = 0; i < ids.length && Date.now() < deadline; i += METHODS_BATCH) {
      this.ensureRunning();
      const chunk = ids.slice(i, i + METHODS_BATCH);
      let rows: Array<{ method_id: string; signature: string | null; candidates: number; source: string }> = [];
      if (!primaryDown) {
        try {
          await this.throttle.wait();
          const found = await this.lookupSignatures(chunk);
          rows = chunk.map((id) => {
            const list = Array.isArray(found[id]) ? (found[id] as Array<Record<string, unknown>>) : [];
            return { method_id: id, signature: pickSignature(list), candidates: list.length, source: 'openchain' };
          });
        } catch {
          primaryDown = true;
        }
      }
      if (primaryDown) {
        for (const id of chunk) {
          if (Date.now() >= deadline) break;
          await this.throttle.wait();
          const r = await this.lookupFourByte(id);
          rows.push({ method_id: id, ...r, source: '4byte' });
        }
      }
      written += await this.repo.upsertMethodSigs(rows);
    }
    await this.repo.advance('methods', { cursor: new Date(), addRows: written, backfillDone: true });
    // Budget spent before every selector was looked up: continue soon.
    return written < ids.length ? 5_000 : METHODS_INTERVAL_MS;
  }

  // ---------------------------------------------------------------------------
  // tokenstats stream (holder counts for the top tokens only)
  // ---------------------------------------------------------------------------

  private async tokenStatsTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const addresses = await this.repo.listTokensForStats(TOKEN_STATS_TOP_N, TOKEN_STATS_MAX_AGE_S);
    let done = 0;
    let processed = 0;
    for (const address of addresses) {
      this.ensureRunning();
      if (Date.now() >= deadline) break;
      processed++;
      await this.throttle.wait();
      const t = await this.client.fetchIngestToken(address);
      const holders = Number(t.holders);
      if (!Number.isInteger(holders) || holders < 0) continue;
      const decimals = typeof t.decimals === 'number' ? t.decimals : null;
      await this.repo.upsertTokenStat(address, holders, scaleRawAmount(t.total_supply_raw, decimals));
      done++;
    }
    await this.repo.advance('tokenstats', { cursor: new Date(), addRows: done, backfillDone: true });
    // Leftovers (budget spent) are picked up on the next, sooner run.
    return processed < addresses.length ? 5_000 : TOKEN_STATS_INTERVAL_MS;
  }
  // ---------------------------------------------------------------------------
  // launchpad stream (Chainzy, CorePad, Signal: launches, graduations, trades)
  // ---------------------------------------------------------------------------

  private async launchMarkets(): Promise<Map<string, LaunchMarket>> {
    const markets = new Map<string, LaunchMarket>();
    for (const l of await this.repo.listLaunchMarkets()) {
      const market: LaunchMarket = { token: l.token, launchpad: l.launchpad as Launchpad, quote: l.quote };
      for (const key of launchMarketKeys(l)) markets.set(key, market);
    }
    return markets;
  }

  private async ingestLaunchpadWindow(start: Date, end: Date): Promise<number> {
    const time = { start_time: toUpstreamTime(start), end_time: toUpstreamTime(end) };
    let inserted = 0;
    // Launches first, so trades in the same window find their market.
    for (const topic0 of LAUNCH_TOPIC_ORDER) {
      await this.pageAll('/logs', { ...time, topic0 }, async (raw) => {
        const rows = dedupeBy(
          raw.map(decodeLaunch).filter((r): r is LaunchRow => r !== null),
          (r) => r.token
        );
        inserted += await this.repo.insertLaunches(rows);
      }, { truncate: true });
    }
    const markets = await this.launchMarkets();
    for (const topic0 of GRADUATION_TOPICS) {
      await this.pageAll('/logs', { ...time, topic0 }, async (raw) => {
        const rows = raw
          .map(decodeGraduation)
          .filter((g): g is NonNullable<typeof g> => g !== null && markets.has(g.curve));
        await this.repo.markGraduated(rows);
      }, { truncate: true });
    }
    for (const topic0 of TRADE_TOPICS) {
      await this.pageAll('/logs', { ...time, topic0 }, async (raw) => {
        const rows = dedupeBy(
          raw.map((r) => decodeLaunchTrade(r, markets)).filter((r): r is LaunchTradeRow => r !== null),
          (r) => `${r.tx_hash}:${r.log_index}`
        );
        inserted += await this.repo.insertLaunchTrades(rows);
      }, { truncate: true });
    }
    return inserted;
  }

  private async launchpadTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const state = await this.repo.getState('launchpad');
    let cursor = state?.cursor ?? null;
    let backfillDone = state?.backfillDone ?? false;

    while (Date.now() < deadline) {
      this.ensureRunning();
      const w = planWindow({
        cursor,
        backfillDone,
        now: new Date(),
        genesis: ELYSIUM_GENESIS,
        stepMs: LAUNCHPAD_STEP_MS,
        overlapMs: LAUNCHPAD_OVERLAP_MS,
        settleMs: LAUNCHPAD_SETTLE_MS,
      });
      if (!w) return LAUNCHPAD_LIVE_INTERVAL_MS;
      const inserted = await this.ingestLaunchpadWindow(w.start, w.end);
      const finishesBackfill = !backfillDone && w.caughtUp;
      await this.repo.advance('launchpad', {
        cursor: w.end,
        addRows: inserted,
        ...(finishesBackfill ? { backfillDone: true } : {}),
      });
      cursor = w.end;
      if (finishesBackfill) {
        backfillDone = true;
        void rawLogger.info('Elysium ingest: launchpad backfill complete');
      }
      if (w.caughtUp) return LAUNCHPAD_LIVE_INTERVAL_MS;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // launchstats stream (holders, top-10 share, creator share per launch)
  // ---------------------------------------------------------------------------

  private async launchStatsTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const targets = await this.repo.listLaunchesForStats(LAUNCH_STATS_BATCH, LAUNCH_STATS_MAX_AGE_S);
    let done = 0;
    let processed = 0;
    for (const t of targets) {
      this.ensureRunning();
      if (Date.now() >= deadline) break;
      processed++;
      await this.throttle.wait();
      const raw = await this.client.fetchIngestTokenHolders(t.token, LAUNCH_HOLDERS_LIMIT);
      const holders = raw
        .map((h) => (h && typeof h === 'object' ? (h as Record<string, unknown>) : null))
        .filter((h): h is Record<string, unknown> => h !== null)
        .map((h) => ({ address: String(h.address ?? '').toLowerCase(), share: Number(h.share) }))
        .filter((h) => /^0x[0-9a-f]{40}$/.test(h.address) && Number.isFinite(h.share) && h.share > 0);

      let count = holders.length;
      if (raw.length >= LAUNCH_HOLDERS_LIMIT) {
        await this.throttle.wait();
        const detail = await this.client.fetchIngestToken(t.token);
        const n = Number(detail.holders);
        if (Number.isInteger(n) && n >= 0) count = n;
      }
      // Supply parked in the token's own market (curve, pool, V4 manager) or
      // locked for the creator is not a holder position.
      const parked = new Set([t.curve, t.pool, CHAINZY_CREATOR_LOCKER, ...V4_POOL_MANAGERS].filter(Boolean));
      const top10 = holders
        .filter((h) => !parked.has(h.address))
        .slice(0, 10)
        .reduce((s, h) => s + h.share, 0);
      const dev = t.creator ? (holders.find((h) => h.address === t.creator)?.share ?? 0) : null;
      await this.repo.updateLaunchStats(t.token, count, top10 * 100, dev === null ? null : dev * 100);
      done++;
    }
    await this.repo.advance('launchstats', { cursor: new Date(), addRows: done, backfillDone: true });
    return processed < targets.length ? 5_000 : LAUNCH_STATS_INTERVAL_MS;
  }
}
