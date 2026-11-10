import { HypeDexerElysiumIndexerClient } from '../../clients/hypedexer/rest/elysium/elysium-indexer.client';
import type {
  ElysiumIngestPageQuery,
  ElysiumIngestPath,
} from '../../clients/hypedexer/rest/elysium/elysium-indexer.client';
import { withDistributedLock } from '../../utils/distributedLock';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { rawLogger } from '../../utils/logger';
import { ElysiumIngestRepository, ElysiumStream } from '../../repositories/prisma/prisma.elysium.repository';
import { ELYSIUM_PROJECTS } from '../../constants/elysium-projects';
import { BLOCK_BATCH, ElysiumRpcLogs } from './elysium-rpc-logs';
import {
  dedupeBy,
  ELYSIUM_GENESIS,
  HOUR_MS,
  MINUTE_MS,
  normalizeBridgeTransfer,
  normalizeLiveTx,
  normalizeToken,
  normalizeTx,
  planWindow,
  toUpstreamTime,
  BridgeRow,
  LiveTxRow,
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
  launchMarketCandidates,
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
/** How often the provider's last indexed block time is read, at least. */
const HEAD_REFRESH_MS = 30_000;
/**
 * A stream about to read up to a time the last known head has not reached reads the head again,
 * but never more often than this (the provider's /stats itself moves every ~8 s).
 */
const HEAD_MIN_REFRESH_MS = 5_000;
/**
 * No window read from the provider ends closer to its head than this. The rows of the head's own
 * second are still being written (2 of 222 missing at head = window end, measured 2026-11-10),
 * while /stats trails the data by 4 to 11 s: with the 15 s settle below, this margin never holds
 * a window back unless the provider itself is late.
 */
const HEAD_MARGIN_MS = 3_000;
/** Behind the clock by more than this, the provider counts as lagging. */
const HEAD_LAG_MS = 2 * MINUTE_MS;

/** Where a log window is read from: the provider's /logs, or the public RPC while the provider lags. */
type LogSource = 'provider' | 'rpc';

/** Work budget per tick so a lock never outlives its TTL. */
const TICK_BUDGET_MS = 40_000;
const LOCK_TTL_S = 120;

const TX_LIVE_INTERVAL_MS = 30_000;
const TX_STEP_MS = HOUR_MS;
/**
 * Rows re-read before the cursor on each live tick. A window is complete 6 to 7 s after its end
 * and its count no longer moves over the next 4 minutes (measured 2026-11-10 on /transactions and
 * /logs), and no window ends past the provider's head: this is a margin on top of both, not what
 * catches late rows. At 120 s on a 30 s cadence every row was read (and billed) five times.
 */
const TX_OVERLAP_MS = 20_000;
const TX_SETTLE_MS = 15_000;

/** Live tx fallback: pause between block batches, so the public RPC is never pushed past its rate. */
const TXLIVE_BATCH_GAP_MS = 1_000;
const TXLIVE_LIVE_INTERVAL_MS = 2_000;
/** While the provider is current there is nothing to read from the RPC. */
const TXLIVE_IDLE_INTERVAL_MS = 60_000;
/** RPC-read rows are dropped once the provider's tx stream has covered them for this long. */
const TXLIVE_KEEP_MS = 24 * HOUR_MS;
/** The project contracts whose calls the live fallback keeps. */
const WATCHED_CONTRACTS: ReadonlySet<string> = new Set(
  ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => c.address.toLowerCase()))
);

const BRIDGE_LIVE_INTERVAL_MS = 60_000;
const BRIDGE_LIVE_WINDOW_MS = 15 * MINUTE_MS;
const BRIDGE_WIDE_EVERY_MS = 15 * MINUTE_MS;
const BRIDGE_WIDE_WINDOW_MS = 26 * HOUR_MS;
/** Withdrawals settle on HyperEVM after hours to days; sweep executed ones over 8d. */
const BRIDGE_EXECUTED_SWEEP_MS = 8 * 24 * HOUR_MS;
const BRIDGE_BACKFILL_STEP_MS = 6 * HOUR_MS;

const TOKENS_INTERVAL_MS = 15 * MINUTE_MS;
/**
 * The provider lists tokens by transfer count, 500,000+ of them (2026-11-10), with no way to ask
 * for the new or the changed ones. Only the head moves: rank 1,000 has 805 transfers, rank 10,000
 * has 14, rank 20,000 has 4, and everything below has 2 or 3. So each run reads the head, which
 * holds every token with real activity, and a slice of the rest, round and round: the whole
 * listing is covered in about six hours. Reading 200 pages a run (the page cap) took over 45
 * minutes for 20,400 credits, and still left out every token past rank 200,000.
 */
const TOKENS_HEAD_PAGES = 20;
const TOKENS_TAIL_PAGES = 20;

const DEX_LIVE_INTERVAL_MS = 60_000;
/** DEX logs are sparse on testnet: one day per backfill window is plenty. */
const DEX_STEP_MS = 24 * HOUR_MS;
const DEX_OVERLAP_MS = 20_000;
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
const LAUNCHPAD_OVERLAP_MS = 20_000;
const LAUNCHPAD_SETTLE_MS = 15_000;

/**
 * The market state kept on each launch (last price, curve sold) is rebuilt from the trades once
 * more a few minutes after every start, for the tokens traded over this window: while a deploy
 * overlaps, the previous release still inserts trades without moving that state.
 */
const LAUNCH_STATE_HEAL_AFTER_MS = 5 * MINUTE_MS;
const LAUNCH_STATE_HEAL_WINDOW_MS = 2 * HOUR_MS;

const LAUNCH_STATS_INTERVAL_MS = 5 * MINUTE_MS;
/**
 * Holder stats are one call per token, and there are 420,000 launches for about a thousand that
 * trade on a given day: read round robin, each token came up every 8 days (54,000 a day, measured
 * 2026-11-10), the traded ones no sooner than the rest. Now the launches never read come first,
 * then the ones traded over the last 24h once their stats are half an hour old; these two take at
 * most two thirds of a batch, so the walk through the quiet ones keeps moving.
 */
const LAUNCH_STATS_ACTIVE_MAX_AGE_S = 30 * 60;
const LAUNCH_STATS_QUIET_MAX_AGE_S = 14 * 60;
const LAUNCH_STATS_BATCH = 60;
const LAUNCH_STATS_PRIORITY = 40;
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
 * - tokens: the most transferred ERC-20s every 15 min, the rest of the listing in slices.
 * - dex: Uniswap V2/V3 pool-creation and swap logs (/logs by topic0), walked
 *   from genesis in 1-day windows, then every 60s like the tx stream.
 * - methods: resolves the top 200 called selectors via a public signature
 *   database every 30 min (cached permanently, misses retried daily).
 * - tokenstats: holder counts (/tokens/{address}) for the top tokens only.
 *
 * Provider lag: no stream moves its cursor past the last block the provider
 * has indexed (its /stats last_block_time), so an indexer outage leaves no
 * hole once it recovers. Meanwhile the log streams (dex, launchpad) read the
 * windows the provider has not reached from the public RPC (eth_getLogs), and
 * txlive follows the chain tip block by block, keeping only calls to the
 * project contracts (elysium_tx_live), whenever the tx stream is behind the
 * clock (stalled or unreachable provider alike). It starts at the tip, not at
 * the tx cursor: the RPC rate leaves too little room to replay the gap.
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
  private readonly rpcLogs = ElysiumRpcLogs.getInstance();
  /** Last read of the provider's head, null until the first successful read. */
  private head: { at: number; value: Date | null } | null = null;

  private stopped = true;
  private timers = new Map<ElysiumStream, NodeJS.Timeout>();
  private failures = new Map<ElysiumStream, number>();
  private lastBridgeWideAt = 0;
  private backfillWindows = 0;
  /** Current tx window length: halves on a page-cap overflow, grows back after. */
  private txStepMs = TX_STEP_MS;
  /** Next block the live tx fallback reads, null until resolved from its cursor. */
  private liveBlock: number | null = null;
  /** When this process started polling, and what it has done about the launch market state since. */
  private startedAt = 0;
  private launchStateFilled = false;
  private launchStateHealed = false;
  /** No new attempt at the launch market state before this time (set after a failed one). */
  private launchStateRetryAt = 0;

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
    this.startedAt = Date.now();
    this.schedule('tx', 0, () => this.txTick());
    this.schedule('txlive', 30_000, () => this.txLiveTick());
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
    if (stream === 'txlive') return TXLIVE_IDLE_INTERVAL_MS / 6;
    if (stream === 'bridge') return BRIDGE_LIVE_INTERVAL_MS;
    if (stream === 'dex') return DEX_LIVE_INTERVAL_MS;
    if (stream === 'methods') return METHODS_INTERVAL_MS;
    if (stream === 'tokenstats') return TOKEN_STATS_INTERVAL_MS;
    if (stream === 'launchpad') return LAUNCHPAD_LIVE_INTERVAL_MS;
    if (stream === 'launchstats') return LAUNCH_STATS_INTERVAL_MS;
    return TOKENS_INTERVAL_MS;
  }

  /**
   * The provider's last indexed block time, and whether it lags (`now` is then that time, else the
   * clock). A failed read keeps the last known head for a while, then falls back to the clock.
   *
   * `wantUpTo`: the caller is about to read up to that time. If the head known so far has not
   * passed it, the head is read again (it has usually moved on since), so a stream is held back
   * by the provider itself and never by an old reading.
   */
  private async ingestHorizon(wantUpTo?: number): Promise<{ now: Date; head: Date | null; lagging: boolean }> {
    const clock = Date.now();
    const age = this.head ? clock - this.head.at : Infinity;
    const known = this.head?.value ?? null;
    const behind = wantUpTo !== undefined && (known === null || known.getTime() - HEAD_MARGIN_MS < wantUpTo);
    if (age >= HEAD_REFRESH_MS || (behind && age >= HEAD_MIN_REFRESH_MS)) {
      try {
        await this.throttle.wait();
        this.head = { at: clock, value: await this.client.fetchIngestHead() };
      } catch (error) {
        if (!this.head || clock - this.head.at > 5 * HEAD_REFRESH_MS) this.head = { at: clock, value: null };
        logDeduplicator.warn('Elysium ingest: provider head unavailable', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    const head = this.head?.value ?? null;
    const lagging = head !== null && clock - head.getTime() > HEAD_LAG_MS;
    return { now: lagging && head ? head : new Date(clock), head, lagging };
  }

  /**
   * The latest time a window read from the provider may end at: a little before its head, or null
   * when the head is not known (the clock alone then bounds the window, as before).
   */
  private providerCeiling(head: Date | null): Date | null {
    return head ? new Date(head.getTime() - HEAD_MARGIN_MS) : null;
  }

  /** The source for a log window: the provider up to its head, the RPC beyond it. */
  private logSource(end: Date, head: Date | null, lagging: boolean): LogSource {
    return lagging && head !== null && end.getTime() > head.getTime() ? 'rpc' : 'provider';
  }

  /** Every log with `topic0` in the window, page by page, from the chosen source. */
  private async pageLogs(
    source: LogSource,
    topic0: string,
    start: Date,
    end: Date,
    onPage: (rows: unknown[]) => Promise<void>
  ): Promise<void> {
    if (source === 'rpc') {
      this.ensureRunning();
      await onPage(await this.rpcLogs.getLogs(topic0, start, end));
      return;
    }
    const time = { start_time: toUpstreamTime(start), end_time: toUpstreamTime(end) };
    await this.pageAll('/logs', { ...time, topic0 }, onPage, { truncate: true });
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
      // Never past what the provider has indexed: the cursor then leaves nothing behind it,
      // whether the provider is a few seconds late or stalled for days.
      const { head } = await this.ingestHorizon(Date.now() - TX_SETTLE_MS);
      const w = planWindow({
        cursor,
        backfillDone,
        now: new Date(Date.now()),
        genesis: ELYSIUM_GENESIS,
        stepMs: this.txStepMs,
        overlapMs: TX_OVERLAP_MS,
        settleMs: TX_SETTLE_MS,
        ceiling: this.providerCeiling(head),
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
  // txlive stream (RPC fallback while the provider lags)
  // ---------------------------------------------------------------------------

  private async txLiveTick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    // Keyed on our own tx cursor, not the provider's head: when the provider is unreachable
    // (no head at all) the tx stream is stuck just the same.
    const txCursor = (await this.repo.getState('tx'))?.cursor ?? null;
    if (txCursor) await this.repo.pruneLiveTxs(new Date(txCursor.getTime() - TXLIVE_KEEP_MS));
    if (!txCursor || Date.now() - txCursor.getTime() <= HEAD_LAG_MS) {
      this.liveBlock = null;
      return TXLIVE_IDLE_INTERVAL_MS;
    }

    if (this.liveBlock === null) {
      const cursor = (await this.repo.getState('txlive'))?.cursor ?? null;
      // Resume a run of this outage; a cursor from an earlier outage starts over at the tip.
      this.liveBlock =
        cursor && cursor.getTime() > txCursor.getTime()
          ? (await this.rpcLogs.blockAtOrBefore(cursor.getTime() / 1000)) + 1
          : await this.rpcLogs.headBlock();
      void rawLogger.info('Elysium ingest: live tx fallback started', { block: this.liveBlock });
    }

    while (Date.now() < deadline) {
      this.ensureRunning();
      const tip = await this.rpcLogs.headBlock();
      const count = Math.min(BLOCK_BATCH, tip - this.liveBlock + 1);
      if (count <= 0) return TXLIVE_LIVE_INTERVAL_MS;
      const blocks = await this.rpcLogs.getBlocks(this.liveBlock, count);
      if (blocks.length > 0) {
        const rows = dedupeBy(
          blocks.flatMap((b) =>
            b.transactions
              .map((tx) => normalizeLiveTx(tx, b, WATCHED_CONTRACTS))
              .filter((r): r is LiveTxRow => r !== null)
          ),
          (r) => r.tx_hash
        );
        const inserted = await this.repo.insertLiveTxs(rows);
        const last = blocks[blocks.length - 1];
        this.liveBlock = last.number + 1;
        await this.repo.advance('txlive', { cursor: new Date(last.timestamp * 1000), addRows: inserted });
      }
      await new Promise((r) => setTimeout(r, TXLIVE_BATCH_GAP_MS));
    }
    // Budget spent but still behind the tip: continue right away.
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
        const { now, lagging } = await this.ingestHorizon();
        const w = planWindow({
          cursor,
          backfillDone: false,
          now,
          genesis: ELYSIUM_GENESIS,
          stepMs: BRIDGE_BACKFILL_STEP_MS,
          overlapMs: 0,
          settleMs: 0,
        });
        // Caught up with a lagging provider: stay in backfill until it moves on.
        if (!w && lagging) return BRIDGE_LIVE_INTERVAL_MS;
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
          ...(w.caughtUp && !lagging ? { backfillDone: true } : {}),
        });
        cursor = w.end;
        if (w.caughtUp && lagging) return BRIDGE_LIVE_INTERVAL_MS;
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

  /**
   * Reads `pages` pages of the token listing from page `from` into the registry. Returns the page
   * to read next, the rows read, and whether the listing ended inside the range.
   */
  private async readTokenPages(from: number, pages: number): Promise<{ next: number; read: number; ended: boolean }> {
    let read = 0;
    for (let page = from; page < from + pages; page++) {
      this.ensureRunning();
      await this.throttle.wait();
      const raw = await this.client.fetchIngestPage('/tokens', { standard: 'erc20', limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      const rows = dedupeBy(
        raw.map(normalizeToken).filter((r): r is TokenRow => r !== null),
        (r) => r.address
      );
      await this.repo.upsertTokens(rows);
      try {
        await this.repo.nameLaunches(rows);
      } catch (error) {
        // Names for the launchpad list are a convenience: never the reason a registry run fails.
        logDeduplicator.warn('Elysium ingest: launches not named from this registry page', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      read += raw.length;
      if (raw.length < PAGE_SIZE) return { next: page + 1, read, ended: true };
    }
    return { next: from + pages, read, ended: false };
  }

  private async tokensTick(): Promise<number> {
    const started = Date.now();
    const head = await this.readTokenPages(0, TOKENS_HEAD_PAGES);
    let read = head.read;
    if (!head.ended) {
      // Where the walk through the rest of the listing stands: kept in the database, so a restart
      // resumes it instead of starting over (with a few deploys a day it would never reach the end).
      const resume = Number((await this.repo.getState('tokenstail'))?.rows ?? 0);
      const tail = await this.readTokenPages(Math.max(TOKENS_HEAD_PAGES, resume), TOKENS_TAIL_PAGES);
      read += tail.read;
      await this.repo.advance('tokenstail', {
        cursor: new Date(),
        setRows: tail.ended ? TOKENS_HEAD_PAGES : tail.next,
        // True once the walk has reached the end of the listing at least once.
        ...(tail.ended ? { backfillDone: true } : {}),
      });
    }
    // rows = tokens read by the latest run, not a running total.
    await this.repo.advance('tokens', { cursor: new Date(), setRows: read, backfillDone: true });
    // From start to start: the head is read every TOKENS_INTERVAL_MS, however long a run took.
    return Math.max(MINUTE_MS, TOKENS_INTERVAL_MS - (Date.now() - started));
  }

  // ---------------------------------------------------------------------------
  // dex stream
  // ---------------------------------------------------------------------------

  private async ingestDexWindow(start: Date, end: Date, source: LogSource): Promise<number> {
    let inserted = 0;
    for (const topic0 of [DEX_TOPICS.v2PairCreated, DEX_TOPICS.v3PoolCreated]) {
      await this.pageLogs(source, topic0, start, end, async (raw) => {
        const rows = dedupeBy(
          raw.map(decodePoolCreated).filter((r): r is DexPoolRow => r !== null),
          (r) => r.pool
        );
        inserted += await this.repo.insertDexPools(rows);
      });
    }
    for (const topic0 of [DEX_TOPICS.v2Swap, DEX_TOPICS.v3Swap]) {
      await this.pageLogs(source, topic0, start, end, async (raw) => {
        const rows = dedupeBy(
          raw.map(decodeSwap).filter((r): r is DexSwapRow => r !== null),
          (r) => `${r.tx_hash}:${r.log_index}`
        );
        inserted += await this.repo.insertDexSwaps(rows);
      });
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
      const { head, lagging } = await this.ingestHorizon(Date.now() - DEX_SETTLE_MS);
      const w = planWindow({
        cursor,
        backfillDone,
        now: new Date(Date.now()),
        genesis: ELYSIUM_GENESIS,
        stepMs: DEX_STEP_MS,
        overlapMs: DEX_OVERLAP_MS,
        settleMs: DEX_SETTLE_MS,
        // While the provider lags, the windows past its head are read from the RPC, which is current.
        ceiling: lagging ? null : this.providerCeiling(head),
      });
      if (!w) return DEX_LIVE_INTERVAL_MS;
      const inserted = await this.ingestDexWindow(w.start, w.end, this.logSource(w.end, head, lagging));
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
  // launchpad stream (Chainzy, CorePad, Signal, Neuriio: launches, graduations, trades)
  // ---------------------------------------------------------------------------

  /**
   * The markets the logs of `raw` can belong to, by market key: read from the launches for the
   * keys these logs name, at the time of the call (so a launch or a graduation inserted earlier
   * in the same window is there).
   */
  private async launchMarketsFor(raw: readonly unknown[]): Promise<Map<string, LaunchMarket>> {
    const markets = new Map<string, LaunchMarket>();
    for (const l of await this.repo.findLaunchMarkets(launchMarketCandidates(raw))) {
      const market: LaunchMarket = { token: l.token, launchpad: l.launchpad as Launchpad, quote: l.quote };
      for (const key of launchMarketKeys(l)) markets.set(key, market);
    }
    return markets;
  }

  private async ingestLaunchpadWindow(start: Date, end: Date, source: LogSource): Promise<number> {
    let inserted = 0;
    // Launches first, so trades in the same window find their market.
    for (const topic0 of LAUNCH_TOPIC_ORDER) {
      await this.pageLogs(source, topic0, start, end, async (raw) => {
        const rows = dedupeBy(
          raw.map(decodeLaunch).filter((r): r is LaunchRow => r !== null),
          (r) => r.token
        );
        inserted += await this.repo.insertLaunches(rows);
      });
    }
    for (const topic0 of GRADUATION_TOPICS) {
      await this.pageLogs(source, topic0, start, end, async (raw) => {
        const known = await this.launchMarketsFor(raw);
        const rows = raw.map(decodeGraduation).filter((g): g is NonNullable<typeof g> => {
          const key = g?.curve ?? g?.token;
          return key !== null && key !== undefined && known.has(key);
        });
        await this.repo.markGraduated(rows);
      });
    }
    // Read per page of logs, after the launches and the graduations above: a pair a graduation
    // just added (Neuriio) is there for its swaps of this window.
    for (const topic0 of TRADE_TOPICS) {
      await this.pageLogs(source, topic0, start, end, async (raw) => {
        const markets = await this.launchMarketsFor(raw);
        const rows = dedupeBy(
          raw.map((r) => decodeLaunchTrade(r, markets)).filter((r): r is LaunchTradeRow => r !== null),
          (r) => `${r.tx_hash}:${r.log_index}`
        );
        inserted += await this.repo.insertLaunchTrades(rows);
      });
    }
    return inserted;
  }

  /**
   * Keeps the market state of the launches (elysium_launch.last_price, curve_sold) whole. The
   * trade insert moves it; this covers what the insert cannot: the rows that existed before the
   * columns did (one rebuild from every trade, recorded under the `launchstate` marker), and the
   * trades the previous release wrote while a deploy overlapped (a rebuild of the recently traded
   * tokens, once, a few minutes after each start). Runs inside the launchpad tick, so never
   * alongside this process's own trade inserts. A failure is logged and tried again later: it
   * must not hold the launchpad stream itself.
   */
  private async ensureLaunchState(): Promise<void> {
    if (Date.now() < this.launchStateRetryAt) return;
    try {
      await this.keepLaunchState();
    } catch (error) {
      this.launchStateRetryAt = Date.now() + 10 * MINUTE_MS;
      logDeduplicator.warn('Elysium ingest: launch market state not rebuilt, retrying later', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async keepLaunchState(): Promise<void> {
    if (!this.launchStateFilled) {
      if (!(await this.repo.getState('launchstate'))?.backfillDone) {
        const written = await this.repo.rebuildLaunchState(null);
        const named = await this.repo.fillLaunchNames();
        await this.repo.advance('launchstate', { cursor: new Date(), setRows: written, backfillDone: true });
        void rawLogger.info('Elysium ingest: launch market state filled', { written, named });
      }
      this.launchStateFilled = true;
    }
    if (!this.launchStateHealed && Date.now() - this.startedAt >= LAUNCH_STATE_HEAL_AFTER_MS) {
      const written = await this.repo.rebuildLaunchState(new Date(Date.now() - LAUNCH_STATE_HEAL_WINDOW_MS));
      this.launchStateHealed = true;
      if (written > 0) void rawLogger.info('Elysium ingest: launch market state healed', { written });
    }
  }

  private async launchpadTick(): Promise<number> {
    await this.ensureLaunchState();
    const deadline = Date.now() + TICK_BUDGET_MS;
    const state = await this.repo.getState('launchpad');
    let cursor = state?.cursor ?? null;
    let backfillDone = state?.backfillDone ?? false;

    while (Date.now() < deadline) {
      this.ensureRunning();
      const { head, lagging } = await this.ingestHorizon(Date.now() - LAUNCHPAD_SETTLE_MS);
      const w = planWindow({
        cursor,
        backfillDone,
        now: new Date(Date.now()),
        genesis: ELYSIUM_GENESIS,
        stepMs: LAUNCHPAD_STEP_MS,
        overlapMs: LAUNCHPAD_OVERLAP_MS,
        settleMs: LAUNCHPAD_SETTLE_MS,
        ceiling: lagging ? null : this.providerCeiling(head),
      });
      if (!w) return LAUNCHPAD_LIVE_INTERVAL_MS;
      const inserted = await this.ingestLaunchpadWindow(w.start, w.end, this.logSource(w.end, head, lagging));
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
    const targets = await this.repo.listLaunchesForStats(
      LAUNCH_STATS_BATCH,
      LAUNCH_STATS_PRIORITY,
      LAUNCH_STATS_ACTIVE_MAX_AGE_S,
      LAUNCH_STATS_QUIET_MAX_AGE_S
    );
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
