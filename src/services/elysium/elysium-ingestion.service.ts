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
import { ElysiumRollupService } from './elysium-rollup.service';
import { IngestRejects } from './elysium-ingest-rejects';
import { ElysiumDayCheckService } from './elysium-day-check.service';
import {
  dedupeBy,
  ELYSIUM_GENESIS,
  HOUR_MS,
  isRowRefusal,
  MINUTE_MS,
  normalizeBridgeTransfer,
  normalizeLiveTx,
  normalizeToken,
  normalizeTx,
  tokenDecimals,
  parseUpstreamTime,
  pgErrorCode,
  planWindow,
  storableText,
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
  graduationKey,
  GraduationRow,
  GRADUATION_TOPICS,
  LAUNCHPAD_TOPICS,
  launchGraduationKeys,
  LAUNCH_TOPIC_ORDER,
  launchMarketCandidates,
  launchMarketKeys,
  launchRejectReason,
  LaunchMarket,
  LaunchRow,
  LaunchTradeRow,
  Launchpad,
  marketRejectReason,
  TRADE_TOPICS,
  V4_POOL_MANAGERS,
} from './elysium-launchpad.util';

const PAGE_SIZE = 1000;
/** Hard stop per window: 200k rows/hour is ~20x the measured peak. */
const MAX_PAGES_PER_WINDOW = 200;
/**
 * Smallest window a time stream shrinks to when a window overflows the page cap. Only there is a
 * window cut (anyone can write to the testnet, and a burst must not stall a stream for ever),
 * and the cut is counted.
 */
const MIN_STEP_MS = 60_000;

class PageCapError extends Error {
  constructor() {
    super('Elysium ingest: window exceeded the page cap');
    this.name = 'PageCapError';
  }
}

/** The provider said there is more to read and returned nothing: the window cannot be trusted. */
class PageIncompleteError extends Error {
  constructor(path: string) {
    super(`Elysium ingest: ${path} announced more rows and returned none`);
    this.name = 'PageIncompleteError';
  }
}
/**
 * Rows of one page the database may refuse and the stream set aside. Past that many the page is
 * not a page with a bad row any more, it is a page the code cannot store: the stream stops on it
 * and says so, as before.
 */
const MAX_REFUSED_PER_PAGE = 25;
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
const DAY_MS = 24 * HOUR_MS;
/**
 * Withdrawals are executed by their owner, when they get to it: half within 25 h of the
 * request, one in ten after more than 8 days, the slowest after 42 (2,611 executed withdrawals,
 * measured 2026-11-11). The sweep above only covers 8 days: 1,736 of the 35,000 older ones were
 * executed after it had stopped looking, and were still "initiated" here. So each wide run also
 * reads one day of older executed withdrawals, walking back to this many days and starting over:
 * the whole range about once a day, one or two pages a run.
 */
const BRIDGE_DEEP_SWEEP_MAX_DAYS = 90;
/**
 * A deposit waiting for its retryable ticket (ticket_created, redeem_failed) leaves the 26 h
 * window still open: the ticket is redeemed or expires within 7 days, and nothing read it again.
 * These are a handful at any time (2 on 2026-11-11): each is read again by its hash on the wide
 * runs, until it is 10 days old.
 */
const BRIDGE_OPEN_DEPOSIT_MAX_AGE_S = 10 * 24 * 3600;
const BRIDGE_OPEN_DEPOSITS_PER_SWEEP = 25;

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
/** Daily comparison with the provider: wait after a run that failed or found its lock taken. */
const DAY_CHECK_RETRY_INTERVAL_MS = 5 * MINUTE_MS;
/** Day rollups: wait after a pass that failed or found the builder's lock taken. */
const ROLLUP_RETRY_INTERVAL_MS = 5 * MINUTE_MS;
/**
 * A token whose holder figures cannot be read is left alone for this long, then tried again.
 * One such token used to end the run where it stood, and came first again on the next run: the
 * tokens behind it were never read (a token the provider answers 4xx for held the whole stream).
 */
const TOKEN_RETRY_AFTER_MS = 30 * MINUTE_MS;
/** This many tokens unreadable in a row is not about the tokens: the run fails and the stream backs off. */
const TOKEN_FAILURES_IN_A_ROW = 3;
/** Tokens remembered as unreadable at most (the oldest is forgotten first). */
const UNREADABLE_TOKENS_MAX = 500;
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

/** A row the provider flags as a system transaction (left out on purpose, never a reject). */
function isSystemTx(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const v = (raw as Record<string, unknown>).is_system;
  return v === true || v === 1 || v === '1' || v === 'true';
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
 * - rollup: not a provider stream. Sums each closed UTC day of elysium_tx into the day
 *   rollups the wide analytics windows read (ElysiumRollupService).
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
  private readonly rollups = ElysiumRollupService.getInstance();
  /** What the running ticks read and did not store; written to the database as each tick ends. */
  private readonly rejects = new IngestRejects();
  /**
   * Per stream, the time up to which its rows were already read once (its cursor before the
   * window being read). A window starts a little before that time on purpose, and the bridge
   * re-reads hours of transfers: what is left out of those re-read rows was counted when they
   * were first read, and is not counted again.
   */
  private readonly countedUpTo = new Map<ElysiumStream, number>();
  /** Tokens whose holder figures could not be read, and when each may be tried again. */
  private readonly unreadableUntil = new Map<string, number>();
  /** The daily comparison of elysium_tx with the provider's own figures, run as one more loop here. */
  private readonly dayCheck = new ElysiumDayCheckService({
    ensureRunning: () => this.ensureRunning(),
    wait: () => this.throttle.wait(),
    head: async () => (await this.ingestHorizon()).head,
    txCursor: async () => (await this.repo.getState('tx'))?.cursor ?? null,
    fetchDaily: (days) => this.client.fetchIngestDaily(days),
    pageTxs: async (start, end, onPage) => {
      await this.pageAll(
        'check',
        '/transactions',
        { start_time: toUpstreamTime(start), end_time: toUpstreamTime(end), include_spam: true, include_system: false },
        // Rows without their fields were counted when the stream first read them.
        (raw) => onPage(dedupeBy(raw.map(normalizeTx).filter((r): r is TxRow => r !== null), (r) => r.tx_hash))
      );
    },
    insertTxs: (rows) => this.writeRows('check', rows, async (part) => (await this.repo.insertTxs(part)).inserted, (r) => r.tx_hash),
    txListed: (hash) => this.client.fetchIngestTxListed(hash),
    rejects: this.rejects,
  });
  /** Last read of the provider's head, null until the first successful read. */
  private head: { at: number; value: Date | null } | null = null;

  private stopped = true;
  private timers = new Map<ElysiumStream, NodeJS.Timeout>();
  private failures = new Map<ElysiumStream, number>();
  private lastBridgeWideAt = 0;
  /** Up to where the bridge stream has read what lay between its cursor and its live window (this process). */
  private bridgeCaughtUpTo = 0;
  /** Where the walk through the deposits still waiting stands, when there are more than a sweep reads. */
  private openDepositOffset = 0;
  private backfillWindows = 0;
  /** Current tx window length: halves on a page-cap overflow, grows back after. */
  private txStepMs = TX_STEP_MS;
  /** The same for the two log streams (their backfill windows are a day long). */
  private dexStepMs = DEX_STEP_MS;
  private launchpadStepMs = LAUNCHPAD_STEP_MS;
  /** Next block the live tx fallback reads, null until resolved from its cursor. */
  private liveBlock: number | null = null;
  /** When this process started polling, and what it has done about the launch market state since. */
  private startedAt = 0;
  private launchStateFilled = false;
  private launchStateHealed = false;
  /** No new attempt at the launch market state before this time (set after a failed one). */
  private launchStateRetryAt = 0;
  /** The same for the one-time re-read of the Kiln graduations. */
  private kilnHistoryDone = false;
  private kilnHistoryRetryAt = 0;

  public static getInstance(): ElysiumIngestionService {
    if (!ElysiumIngestionService.instance) {
      ElysiumIngestionService.instance = new ElysiumIngestionService();
    }
    return ElysiumIngestionService.instance;
  }

  public static isEnabled(): boolean {
    return (process.env.ELYSIUM_INGEST_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  }

  /** The daily comparison with the provider (and the re-read of a day that differs) can be switched off on its own. */
  public static isDayCheckEnabled(): boolean {
    return (process.env.ELYSIUM_DAY_CHECK_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
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
    if (ElysiumRollupService.isEnabled()) this.schedule('rollup', 60_000, () => this.rollups.tick());
    if (ElysiumIngestionService.isDayCheckEnabled()) this.schedule('check', 150_000, () => this.dayCheck.tick());
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
    try {
      return await this.runLockedTick(stream, tick);
    } finally {
      await this.flushRejects();
    }
  }

  /**
   * Writes what the ticks left out since the last write (see IngestRejects). A failed write keeps
   * the counts for the next one: they are a few entries, one per stream and reason.
   */
  private async flushRejects(): Promise<void> {
    const rows = this.rejects.take();
    if (rows.length === 0) return;
    try {
      await this.repo.addRejects(rows);
    } catch (error) {
      this.rejects.restore(rows);
      logDeduplicator.warn('Elysium ingest: reject counts not written, kept for the next tick', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async runLockedTick(stream: ElysiumStream, tick: () => Promise<number>): Promise<number> {
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
    if (stream === 'rollup') return ROLLUP_RETRY_INTERVAL_MS;
    if (stream === 'check') return DAY_CHECK_RETRY_INTERVAL_MS;
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
    stream: ElysiumStream,
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
    // A topic with more logs than the page cap in this window: the caller reads it in halves,
    // down to the smallest step. It used to be cut here, at any window length, and the cursor
    // moved on: a day of backfill with 200,000 swaps of one kind lost the rest for good.
    await this.pageAll(stream, '/logs', { ...time, topic0 }, onPage, { truncate: this.atSmallestStep(stream) });
  }

  /** Whether the stream's windows are down to the smallest step (only then may one be cut). */
  private atSmallestStep(stream: ElysiumStream): boolean {
    if (stream === 'dex') return this.dexStepMs <= MIN_STEP_MS;
    if (stream === 'launchpad') return this.launchpadStepMs <= MIN_STEP_MS;
    return true;
  }

  private ensureRunning(): void {
    if (this.stopped) throw new IngestStoppedError();
  }

  /**
   * Maps a page of provider rows, counting the ones the mapper refuses (rows without the fields
   * a row needs) instead of dropping them without a trace. `expected` tells the rows the mapper
   * leaves out on purpose.
   */
  private mapCounted<T>(
    stream: ElysiumStream,
    raw: readonly unknown[],
    map: (row: unknown) => T | null,
    expected: (row: unknown) => boolean = () => false
  ): T[] {
    const rows: T[] = [];
    for (const r of raw) {
      const row = map(r);
      if (row !== null) rows.push(row);
      else if (!expected(r) && this.firstRead(stream, r)) {
        this.rejects.note(stream, 'row-malformed', JSON.stringify(r ?? null).slice(0, 300));
      }
    }
    return rows;
  }

  /**
   * Writes a page of rows, and when the database refuses the statement because of the data
   * (isRowRefusal), finds the rows at fault by halves, sets them aside and stores the rest.
   *
   * The normalisers already clean and bound what is known to break (see elysium-ingest.util);
   * this is for what nobody thought of. Without it one refused value fails its page on every
   * run and the stream never passes it. A refusal that is not about the data (a lost
   * connection, a time limit, a lock) is thrown as it is: the tick fails and is run again.
   */
  private async writeRows<T>(
    stream: ElysiumStream,
    rows: T[],
    write: (rows: T[]) => Promise<number>,
    describe: (row: T) => string
  ): Promise<number> {
    return this.writeHalves(stream, rows, write, describe, { left: MAX_REFUSED_PER_PAGE });
  }

  private async writeHalves<T>(
    stream: ElysiumStream,
    rows: T[],
    write: (rows: T[]) => Promise<number>,
    describe: (row: T) => string,
    budget: { left: number }
  ): Promise<number> {
    if (rows.length === 0) return 0;
    try {
      return await write(rows);
    } catch (error) {
      if (!isRowRefusal(error)) throw error;
      if (rows.length === 1) {
        if (budget.left <= 0) throw error;
        budget.left -= 1;
        this.rejects.note(stream, 'row-refused', `${pgErrorCode(error)} ${describe(rows[0])}`);
        logDeduplicator.warn('Elysium ingest: a row the database refused was set aside', { stream, code: pgErrorCode(error) });
        return 0;
      }
      const mid = rows.length >> 1;
      const first = await this.writeHalves(stream, rows.slice(0, mid), write, describe, budget);
      return first + (await this.writeHalves(stream, rows.slice(mid), write, describe, budget));
    }
  }

  /** False for a row of the part of a window that was read before (see countedUpTo). */
  private firstRead(stream: ElysiumStream, raw: unknown): boolean {
    const upTo = this.countedUpTo.get(stream);
    if (upTo === undefined || !raw || typeof raw !== 'object') return true;
    const r = raw as Record<string, unknown>;
    const time = parseUpstreamTime(r.block_time ?? r.initiated_time);
    return time === null || time.getTime() > upTo;
  }

  /**
   * Pages a list endpoint to its end, handing each page to `onPage`.
   *
   * The end is what the provider says it is (`has_more`), and the next page starts after the
   * rows actually received. A page shorter than asked used to mean "done": a page the provider
   * cut short then ended the window, and the cursor moved past the rows it had not sent.
   * (Measured 2026-11-11: today `has_more` is true exactly when the page is full, so on a
   * healthy provider both rules agree.) A page that announces more and carries nothing fails the
   * window: it is read again later, and the cursor stays.
   *
   * At the page cap it throws PageCapError, for the caller to read the window in smaller steps;
   * with `truncate` (the smallest step) it keeps what it read, counts the cut and returns true.
   */
  private async pageAll(
    stream: ElysiumStream,
    path: ElysiumIngestPath,
    params: Record<string, string | boolean>,
    onPage: (rows: unknown[]) => Promise<void>,
    opts: { truncate?: boolean } = {}
  ): Promise<boolean> {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
      this.ensureRunning();
      await this.throttle.wait();
      const query: ElysiumIngestPageQuery = { ...params, limit: PAGE_SIZE, offset };
      const { rows, hasMore } = await this.client.fetchIngestPage(path, query);
      if (hasMore === true && rows.length === 0) throw new PageIncompleteError(path);
      await onPage(rows);
      offset += rows.length;
      if (hasMore === false || (hasMore === null && rows.length < PAGE_SIZE)) return false;
    }
    if (!opts.truncate) throw new PageCapError();
    this.rejects.note(stream, 'window-truncated', `${path} ${JSON.stringify(params)} cut after ${offset} rows`);
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
      this.countedUpTo.set('tx', cursor ? cursor.getTime() : -Infinity);

      let inserted = 0;
      try {
        await this.pageAll(
          'tx',
          '/transactions',
          {
            start_time: toUpstreamTime(w.start),
            end_time: toUpstreamTime(w.end),
            include_spam: true,
            include_system: false,
          },
          async (raw) => {
            // System transactions are asked out of the answer; one that comes anyway is not a reject.
            const rows = dedupeBy(this.mapCounted<TxRow>('tx', raw, normalizeTx, isSystemTx), (r) => r.tx_hash);
            inserted += await this.writeRows('tx', rows, async (part) => (await this.repo.insertTxs(part)).inserted, (r) => r.tx_hash);
          },
          // At the smallest step, keep what was read and move on.
          { truncate: this.txStepMs <= MIN_STEP_MS }
        );
      } catch (error) {
        if (!(error instanceof PageCapError)) throw error;
        // Too many txs in this window (a spam burst): retry it in halves.
        this.txStepMs = Math.max(MIN_STEP_MS, Math.floor(this.txStepMs / 2));
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
        const inserted = await this.writeRows('txlive', rows, (part) => this.repo.insertLiveTxs(part), (r) => r.tx_hash);
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
    await this.pageAll('bridge', '/bridge/transfers', params, async (raw) => {
      const rows = dedupeBy(
        this.mapCounted<BridgeRow>('bridge', raw, (r) => normalizeBridgeTransfer(r, (field, value) => this.noteCut('bridge', r, field, value))),
        (r) => r.transfer_id
      );
      changed += await this.writeRows('bridge', rows, (part) => this.repo.upsertBridgeTransfers(part), (r) => r.transfer_id);
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

    const clock = Date.now();
    // What the provider has indexed: its head while it lags, the clock otherwise. The cursor is
    // that time, not the time of the run: it used to be the clock, so after a provider outage
    // longer than the 26 h window the transfers begun in between were never read (the provider
    // indexes them once it is back, with their own, older, initiation time).
    const { head, lagging } = await this.ingestHorizon();
    const horizon = lagging && head ? Math.min(clock, head.getTime()) : clock;
    const cursorMs = state.cursor ? Math.min(state.cursor.getTime(), clock) : horizon;
    // The live windows re-read transfers of the last hours: only the ones begun since the last run are new.
    this.countedUpTo.set('bridge', state.cursor ? cursorMs : -Infinity);
    const wide = clock - this.lastBridgeWideAt >= BRIDGE_WIDE_EVERY_MS;
    const liveStart = clock - (wide ? BRIDGE_WIDE_WINDOW_MS : BRIDGE_LIVE_WINDOW_MS);

    // What lies between the cursor and the live window (the stream did not run for a while, or
    // the provider lagged): read from the cursor, in steps, before anything else. While the
    // provider stands still there is nothing more to read past its head: once is enough.
    const gapEnd = Math.min(liveStart, horizon);
    if (cursorMs < liveStart && gapEnd > this.bridgeCaughtUpTo) {
      let from = Math.max(ELYSIUM_GENESIS.getTime(), cursorMs - BRIDGE_LIVE_WINDOW_MS);
      while (from < gapEnd) {
        this.ensureRunning();
        // Out of time: the cursor says where this stopped, the next run goes on from there.
        if (Date.now() >= deadline) return 0;
        const to = Math.min(from + BRIDGE_BACKFILL_STEP_MS, gapEnd);
        const caught = await this.ingestBridgeWindow({
          start_time: toUpstreamTime(new Date(from)),
          end_time: toUpstreamTime(new Date(to)),
        });
        await this.repo.advance('bridge', { cursor: new Date(to), addRows: caught });
        from = to;
      }
      this.bridgeCaughtUpTo = gapEnd;
    }

    let changed = 0;
    // Nothing of the live window is indexed while the provider's head is before it.
    if (horizon >= liveStart) {
      changed += await this.ingestBridgeWindow({
        start_time: toUpstreamTime(new Date(liveStart)),
        end_time: toUpstreamTime(new Date(clock)),
      });
    }
    if (wide) {
      changed += await this.ingestBridgeWindow({
        direction: 'withdrawal',
        status: 'executed',
        start_time: toUpstreamTime(new Date(clock - BRIDGE_EXECUTED_SWEEP_MS)),
        end_time: toUpstreamTime(new Date(clock)),
      });
      changed += await this.sweepOldWithdrawals(clock);
      changed += await this.recheckOpenDeposits();
      this.lastBridgeWideAt = clock;
    }
    await this.repo.advance('bridge', { cursor: new Date(horizon), addRows: changed });
    return BRIDGE_LIVE_INTERVAL_MS;
  }

  /**
   * One day of the executed withdrawals older than the 8-day sweep (see
   * BRIDGE_DEEP_SWEEP_MAX_DAYS), and moves on to the day before for the next run. Where the walk
   * stands is kept in the database, so a restart resumes it.
   */
  private async sweepOldWithdrawals(clock: number): Promise<number> {
    const first = Math.ceil(BRIDGE_EXECUTED_SWEEP_MS / DAY_MS);
    const last = Math.min(BRIDGE_DEEP_SWEEP_MAX_DAYS, Math.ceil((clock - ELYSIUM_GENESIS.getTime()) / DAY_MS));
    if (first >= last) return 0;
    const stored = Number((await this.repo.getState('bridgedeep'))?.rows ?? first);
    const back = stored >= first && stored < last ? stored : first;
    const changed = await this.ingestBridgeWindow({
      direction: 'withdrawal',
      status: 'executed',
      start_time: toUpstreamTime(new Date(clock - (back + 1) * DAY_MS)),
      end_time: toUpstreamTime(new Date(clock - back * DAY_MS)),
    });
    const next = back + 1 >= last ? first : back + 1;
    await this.repo.advance('bridgedeep', {
      cursor: new Date(clock),
      setRows: next,
      // True once the walk has reached its end at least once.
      ...(next === first ? { backfillDone: true } : {}),
    });
    return changed;
  }

  /**
   * Reads again, by their hash, the deposits still waiting for their ticket that the live
   * windows no longer cover (see BRIDGE_OPEN_DEPOSIT_MAX_AGE_S). One that cannot be read is
   * counted and tried again at the next sweep; three in a row fail the run.
   */
  private async recheckOpenDeposits(): Promise<number> {
    const open = await this.repo.listOpenDeposits(
      BRIDGE_WIDE_WINDOW_MS / 1000,
      BRIDGE_OPEN_DEPOSIT_MAX_AGE_S,
      BRIDGE_OPEN_DEPOSITS_PER_SWEEP,
      this.openDepositOffset
    );
    // A full batch: the next sweep reads the ones after it; else start over from the oldest.
    this.openDepositOffset = open.length >= BRIDGE_OPEN_DEPOSITS_PER_SWEEP ? this.openDepositOffset + open.length : 0;
    let changed = 0;
    let failedInARow = 0;
    for (const deposit of open) {
      this.ensureRunning();
      await this.throttle.wait();
      let raw: unknown[];
      try {
        raw = await this.client.fetchIngestBridgeTransfers(deposit.tx_hash);
        failedInARow = 0;
      } catch (error) {
        if (error instanceof IngestStoppedError || ++failedInARow >= TOKEN_FAILURES_IN_A_ROW) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.rejects.note('bridge', 'transfer-unreadable', `${deposit.transfer_id} ${message.slice(0, 160)}`);
        continue;
      }
      // Without a status filter the answer can hold other transfers of the same transaction: all are stored.
      const rows = dedupeBy(
        raw.map((r) => normalizeBridgeTransfer(r)).filter((r): r is BridgeRow => r !== null),
        (r) => r.transfer_id
      );
      changed += await this.writeRows('bridge', rows, (part) => this.repo.upsertBridgeTransfers(part), (r) => r.transfer_id);
    }
    return changed;
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
      const { rows: raw, hasMore } = await this.client.fetchIngestPage('/tokens', { standard: 'erc20', limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      const rows = dedupeBy(
        this.mapCounted<TokenRow>('tokens', raw, (r) => normalizeToken(r, (field, value) => this.noteCut('tokens', r, field, value))),
        (r) => r.address
      );
      await this.writeRows('tokens', rows, (part) => this.repo.upsertTokens(part), (r) => r.address);
      try {
        await this.repo.nameLaunches(rows);
      } catch (error) {
        // Names for the launchpad list are a convenience: never the reason a registry run fails.
        logDeduplicator.warn('Elysium ingest: launches not named from this registry page', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      read += raw.length;
      // The listing ends where the provider says it does; without the flag, at a short page.
      if (hasMore === false || (hasMore === null && raw.length < PAGE_SIZE)) return { next: page + 1, read, ended: true };
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
      await this.pageLogs('dex', source, topic0, start, end, async (raw) => {
        const rows = dedupeBy(this.decodeCounted<DexPoolRow>('dex', raw, decodePoolCreated), (r) => r.pool);
        inserted += await this.writeRows('dex', rows, (part) => this.repo.insertDexPools(part), (r) => r.pool);
      });
    }
    for (const topic0 of [DEX_TOPICS.v2Swap, DEX_TOPICS.v3Swap]) {
      await this.pageLogs('dex', source, topic0, start, end, async (raw) => {
        const rows = dedupeBy(this.decodeCounted<DexSwapRow>('dex', raw, decodeSwap), (r) => `${r.tx_hash}:${r.log_index}`);
        inserted += await this.writeRows('dex', rows, (part) => this.repo.insertDexSwaps(part), (r) => `${r.tx_hash}:${r.log_index}`);
      });
    }
    return inserted;
  }

  /**
   * Decodes a page of logs read by topic, counting the ones that carry the topic and do not
   * decode: with a topic filter every log of the page is meant for this decoder.
   */
  private decodeCounted<T>(stream: ElysiumStream, raw: readonly unknown[], decode: (log: unknown) => T | null): T[] {
    const rows: T[] = [];
    for (const r of raw) {
      const row = decode(r);
      if (row !== null) rows.push(row);
      else if (this.firstRead(stream, r)) this.rejects.note(stream, 'log-undecodable', JSON.stringify(r ?? null).slice(0, 300));
    }
    return rows;
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
        stepMs: this.dexStepMs,
        overlapMs: DEX_OVERLAP_MS,
        settleMs: DEX_SETTLE_MS,
        // While the provider lags, the windows past its head are read from the RPC, which is current.
        ceiling: lagging ? null : this.providerCeiling(head),
      });
      if (!w) return DEX_LIVE_INTERVAL_MS;
      this.countedUpTo.set('dex', cursor ? cursor.getTime() : -Infinity);
      let inserted: number;
      try {
        inserted = await this.ingestDexWindow(w.start, w.end, this.logSource(w.end, head, lagging));
      } catch (error) {
        if (!(error instanceof PageCapError)) throw error;
        // One topic has more logs in this window than the page cap: read it in halves (the rows
        // already stored are skipped by their key when the halves are read).
        this.dexStepMs = Math.max(MIN_STEP_MS, Math.floor(this.dexStepMs / 2));
        continue;
      }
      this.dexStepMs = Math.min(DEX_STEP_MS, this.dexStepMs * 2);
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
      // Signatures are text anyone may have registered in a public database: cleaned like any other.
      const clean = rows.map((r) => ({ ...r, signature: r.signature === null ? null : storableText(r.signature) }));
      written += await this.writeRows('methods', clean, (part) => this.repo.upsertMethodSigs(part), (r) => r.method_id);
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
    let failedInARow = 0;
    for (const address of addresses) {
      this.ensureRunning();
      if (Date.now() >= deadline) break;
      processed++;
      if (this.isSetAside(address)) continue;
      await this.throttle.wait();
      let t: Record<string, unknown>;
      try {
        t = await this.client.fetchIngestToken(address);
        failedInARow = 0;
      } catch (error) {
        this.setTokenAside('tokenstats', address, error, ++failedInARow);
        continue;
      }
      const holders = Number(t.holders);
      if (!Number.isInteger(holders) || holders < 0) continue;
      const decimals = tokenDecimals(t.decimals);
      await this.repo.upsertTokenStat(address, holders, scaleRawAmount(t.total_supply_raw, decimals));
      done++;
    }
    await this.repo.advance('tokenstats', { cursor: new Date(), addRows: done, backfillDone: true });
    // Leftovers (budget spent) are picked up on the next, sooner run.
    return processed < addresses.length ? 5_000 : TOKEN_STATS_INTERVAL_MS;
  }
  /**
   * Gives a new launch its name and symbol from the provider's page of its token, on its first
   * holder read (a few minutes after it appears). The launch events of Signal, Chainzy and
   * aka.fun carry no name: such a launch took it from the token registry, whose walk reaches a
   * token with two or three transfers 6 to 12 hours after its creation, and the launchpad list
   * showed an address meanwhile. One more call (3 credits) per such launch, once. A failure is
   * not one of the stream: the registry walk still brings the name later.
   */
  private async nameNewLaunch(token: string, known: Record<string, unknown> | null): Promise<void> {
    try {
      let detail = known;
      if (!detail) {
        await this.throttle.wait();
        detail = await this.client.fetchIngestToken(token);
      }
      const row = normalizeToken({ ...detail, address: token });
      if (!row || (row.symbol === null && row.name === null)) return;
      await this.writeRows('launchstats', [row], (part) => this.repo.upsertTokens(part), (r) => r.address);
      await this.repo.nameLaunches([row]);
    } catch (error) {
      if (error instanceof IngestStoppedError) throw error;
      logDeduplicator.warn('Elysium ingest: new launch not named from its token page', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /**
   * A token whose figures the provider would not give: counted, left alone for a while, and the
   * run goes on with the next one. `inARow` such tokens in a row is the provider failing, not
   * the tokens: the error is thrown, so the stream records it and backs off like any other.
   */
  private setTokenAside(stream: ElysiumStream, token: string, error: unknown, inARow: number): void {
    if (error instanceof IngestStoppedError) throw error;
    if (inARow >= TOKEN_FAILURES_IN_A_ROW) throw error;
    const now = Date.now();
    this.unreadableUntil.delete(token);
    if (this.unreadableUntil.size >= UNREADABLE_TOKENS_MAX) {
      const oldest = this.unreadableUntil.keys().next().value;
      if (oldest !== undefined) this.unreadableUntil.delete(oldest);
    }
    this.unreadableUntil.set(token, now + TOKEN_RETRY_AFTER_MS);
    const message = error instanceof Error ? error.message : String(error);
    this.rejects.note(stream, 'token-unreadable', `${token} ${message.slice(0, 160)}`);
  }

  private isSetAside(token: string): boolean {
    const until = this.unreadableUntil.get(token);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.unreadableUntil.delete(token);
    return false;
  }

  /** The tokens still set aside, for the queries that pick the next ones to read. */
  private tokensSetAside(): string[] {
    const now = Date.now();
    for (const [token, until] of this.unreadableUntil) if (now >= until) this.unreadableUntil.delete(token);
    return [...this.unreadableUntil.keys()];
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
      await this.pageLogs('launchpad', source, topic0, start, end, async (raw) => {
        const launches: LaunchRow[] = [];
        for (const r of raw) {
          const row = decodeLaunch(r);
          if (row) launches.push(row);
          else if (this.firstRead('launchpad', r)) this.noteLogReject(launchRejectReason(r));
        }
        inserted += await this.writeRows('launchpad', dedupeBy(launches, (r) => r.token), (part) => this.repo.insertLaunches(part), (r) => r.token);
      });
    }
    for (const topic0 of GRADUATION_TOPICS) {
      await this.pageLogs('launchpad', source, topic0, start, end, async (raw) => {
        await this.markGraduations(raw);
      });
    }
    // Read per page of logs, after the launches and the graduations above: a pair a graduation
    // just added (Neuriio) is there for its swaps of this window.
    for (const topic0 of TRADE_TOPICS) {
      await this.pageLogs('launchpad', source, topic0, start, end, async (raw) => {
        const markets = await this.launchMarketsFor(raw);
        const trades: LaunchTradeRow[] = [];
        for (const r of raw) {
          const row = decodeLaunchTrade(r, markets);
          if (row) trades.push(row);
          else if (this.firstRead('launchpad', r)) this.noteLogReject(marketRejectReason(r, (k) => markets.has(k)));
        }
        inserted += await this.writeRows(
          'launchpad',
          dedupeBy(trades, (r) => `${r.tx_hash}:${r.log_index}`),
          (part) => this.repo.insertLaunchTrades(part),
          (r) => `${r.tx_hash}:${r.log_index}`
        );
      });
    }
    return inserted;
  }

  /** A status-like value longer than its column, stored cut: counted, with the value, for a first read. */
  private noteCut(stream: ElysiumStream, raw: unknown, field: string, value: string): void {
    if (this.firstRead(stream, raw)) this.rejects.note(stream, 'text-truncated', `${field}=${value}`);
  }

  /**
   * Marks the launches a page of graduation logs names as graduated, and returns how many rows
   * that changed. A graduation is kept when a launch we hold graduates under its key
   * (launchGraduationKeys); one a pad emitted for a token never seen launching is counted.
   */
  private async markGraduations(raw: readonly unknown[]): Promise<number> {
    const keys = new Set<string>();
    const tokens = new Set<string>();
    for (const l of await this.repo.findLaunchMarkets(launchMarketCandidates(raw))) {
      tokens.add(l.token);
      for (const key of launchGraduationKeys(l)) keys.add(key);
    }
    const rows: GraduationRow[] = [];
    raw.forEach((log) => {
      const g = decodeGraduation(log);
      const key = g ? graduationKey(g) : null;
      if (g && key !== null && keys.has(key)) rows.push(g);
      else if (this.firstRead('launchpad', log)) this.noteLogReject(marketRejectReason(log, (k) => tokens.has(k)));
    });
    return this.writeRows('launchpad', rows, (part) => this.repo.markGraduated(part), (r) => `graduation ${r.curve ?? r.token}`);
  }

  private noteLogReject(reject: { reason: 'log-malformed' | 'log-undecodable' | 'launch-unknown-emitter' | 'market-unknown'; sample: string } | null): void {
    if (reject) this.rejects.note('launchpad', reject.reason, reject.sample);
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

  /**
   * Once: the Kiln graduations of the windows the stream read before it could match them (see
   * launchGraduationKeys). One topic, from genesis to where the stream stands: from the
   * provider up to its head, from the RPC past it. Later windows are read by the stream itself.
   * A failure is logged and tried again later: it must not hold the launchpad stream.
   */
  private async ensureKilnGraduations(cursor: Date | null): Promise<void> {
    if (this.kilnHistoryDone || !cursor || Date.now() < this.kilnHistoryRetryAt) return;
    try {
      if (!(await this.repo.getState('kilngrads'))?.backfillDone) {
        const { head, lagging } = await this.ingestHorizon();
        const providerEnd = lagging && head && head.getTime() < cursor.getTime() ? head : cursor;
        let marked = 0;
        const onPage = async (raw: unknown[]): Promise<void> => {
          marked += await this.markGraduations(raw);
        };
        await this.pageAll(
          'launchpad',
          '/logs',
          { start_time: toUpstreamTime(ELYSIUM_GENESIS), end_time: toUpstreamTime(providerEnd), topic0: LAUNCHPAD_TOPICS.kilnGraduated },
          onPage
        );
        if (providerEnd.getTime() < cursor.getTime()) {
          await onPage(await this.rpcLogs.getLogs(LAUNCHPAD_TOPICS.kilnGraduated, providerEnd, cursor));
        }
        await this.repo.advance('kilngrads', { cursor, setRows: marked, backfillDone: true });
        void rawLogger.info('Elysium ingest: Kiln graduation history read', { marked });
      }
      this.kilnHistoryDone = true;
    } catch (error) {
      if (error instanceof IngestStoppedError) throw error;
      this.kilnHistoryRetryAt = Date.now() + 10 * MINUTE_MS;
      logDeduplicator.warn('Elysium ingest: Kiln graduation history not read, retrying later', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async launchpadTick(): Promise<number> {
    await this.ensureLaunchState();
    const deadline = Date.now() + TICK_BUDGET_MS;
    const state = await this.repo.getState('launchpad');
    let cursor = state?.cursor ?? null;
    let backfillDone = state?.backfillDone ?? false;
    // The history only matters once the stream has passed it: during its first backfill it reads everything itself.
    if (backfillDone) await this.ensureKilnGraduations(cursor);

    while (Date.now() < deadline) {
      this.ensureRunning();
      const { head, lagging } = await this.ingestHorizon(Date.now() - LAUNCHPAD_SETTLE_MS);
      const w = planWindow({
        cursor,
        backfillDone,
        now: new Date(Date.now()),
        genesis: ELYSIUM_GENESIS,
        stepMs: this.launchpadStepMs,
        overlapMs: LAUNCHPAD_OVERLAP_MS,
        settleMs: LAUNCHPAD_SETTLE_MS,
        ceiling: lagging ? null : this.providerCeiling(head),
      });
      if (!w) return LAUNCHPAD_LIVE_INTERVAL_MS;
      this.countedUpTo.set('launchpad', cursor ? cursor.getTime() : -Infinity);
      let inserted: number;
      try {
        inserted = await this.ingestLaunchpadWindow(w.start, w.end, this.logSource(w.end, head, lagging));
      } catch (error) {
        if (!(error instanceof PageCapError)) throw error;
        this.launchpadStepMs = Math.max(MIN_STEP_MS, Math.floor(this.launchpadStepMs / 2));
        continue;
      }
      this.launchpadStepMs = Math.min(LAUNCHPAD_STEP_MS, this.launchpadStepMs * 2);
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
      LAUNCH_STATS_QUIET_MAX_AGE_S,
      this.tokensSetAside()
    );
    let done = 0;
    let processed = 0;
    let failedInARow = 0;
    for (const t of targets) {
      this.ensureRunning();
      if (Date.now() >= deadline) break;
      processed++;
      let raw: unknown[];
      let detail: Record<string, unknown> | null = null;
      try {
        await this.throttle.wait();
        raw = await this.client.fetchIngestTokenHolders(t.token, LAUNCH_HOLDERS_LIMIT);
        if (raw.length >= LAUNCH_HOLDERS_LIMIT) {
          await this.throttle.wait();
          detail = await this.client.fetchIngestToken(t.token);
        }
        failedInARow = 0;
      } catch (error) {
        this.setTokenAside('launchstats', t.token, error, ++failedInARow);
        continue;
      }
      if (t.needsName) await this.nameNewLaunch(t.token, detail);
      const holders = raw
        .map((h) => (h && typeof h === 'object' ? (h as Record<string, unknown>) : null))
        .filter((h): h is Record<string, unknown> => h !== null)
        .map((h) => ({ address: String(h.address ?? '').toLowerCase(), share: Number(h.share) }))
        .filter((h) => /^0x[0-9a-f]{40}$/.test(h.address) && Number.isFinite(h.share) && h.share > 0);

      let count = holders.length;
      if (detail) {
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
