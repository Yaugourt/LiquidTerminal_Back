import { BaseApiService } from '../../core/base.api.service';
import { redisService } from '../../core/redis.service';
import { AssetContext, SpotContext } from '../../types/market.types';
import { startGuardedInterval } from '../../utils/guardedInterval';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { OnDemandSnapshot, SnapshotStore } from '../../utils/onDemandSnapshot';
import { redisSnapshotStore } from '../../utils/redisSnapshotStore';

/** Hyperliquid `tokenDetails` as sent: decimal strings, null where a token has none. */
interface RawTokenDetails {
  name: string;
  maxSupply: string;
  totalSupply: string;
  circulatingSupply: string;
  szDecimals: number;
  weiDecimals: number;
  midPx: string | null;
  markPx: string;
  prevDayPx: string;
  genesis: {
    userBalances?: [string, string][];
    existingTokenBalances?: unknown[];
  } | null;
  deployer: string | null;
  deployGas: string | null;
  deployTime: string | null;
  seededUsdc: string;
  nonCirculatingUserBalances?: [string, string][];
  futureEmissions: string;
}

/**
 * `tokenDetails` without its address lists: every scalar field as sent, and
 * the length of each list.
 */
export interface TokenDetailsSummary {
  name: string;
  maxSupply: string;
  totalSupply: string;
  circulatingSupply: string;
  szDecimals: number;
  weiDecimals: number;
  midPx: string | null;
  markPx: string;
  prevDayPx: string;
  deployer: string | null;
  deployGas: string | null;
  deployTime: string | null;
  seededUsdc: string;
  futureEmissions: string;
  /** `genesis.userBalances` length (0 without a genesis). */
  genesisUserCount: number;
  /** `genesis.existingTokenBalances` length (0 without a genesis). */
  genesisExistingTokenCount: number;
  /** `nonCirculatingUserBalances` length. */
  nonCirculatingUserCount: number;
}

export interface TokenDetailsSnapshot {
  details: TokenDetailsSummary;
  /** Epoch ms of the Hyperliquid read. */
  lastUpdate: number;
}

/** The fields the spot poller refreshes every 10 s (`spot:raw_data`). */
type LiveFieldName = 'markPx' | 'midPx' | 'prevDayPx' | 'circulatingSupply' | 'totalSupply';
type LiveFields = Pick<TokenDetailsSummary, LiveFieldName>;

/**
 * Only what the spot meta and the spot poller know: the rest of the fields
 * are null. Served when no summary can be read in time, instead of an error;
 * the next poll gets the whole summary.
 */
export type TokenDetailsPartial = { [K in keyof TokenDetailsSummary]: TokenDetailsSummary[K] | null };

export interface TokenDetailsResult {
  details: TokenDetailsSummary | TokenDetailsPartial;
  /** Epoch ms of the Hyperliquid tokenDetails read (0 for a partial answer). */
  lastUpdate: number;
  /** True when only the spot meta and live fields could be served. */
  partial: boolean;
}

/** One listed token as the spot poller's cache describes it. */
interface SpotTokenState {
  name: string;
  szDecimals: number;
  weiDecimals: number;
  /** From the token's first pair (lowest universe index), as tokenDetails prices it; null without a pair. */
  live: LiveFields | null;
}

/** spotMetaAndAssetCtxs contexts as the poller stores them (totalSupply included). */
type RawSpotAssetContext = AssetContext & { totalSupply?: string; midPx: string | null };

export class UnknownTokenIdError extends Error {
  constructor(tokenId: string) {
    super(`Unknown spot token id: ${tokenId}`);
    this.name = 'UnknownTokenIdError';
  }
}

export class TokenDetailsUnavailableError extends Error {
  constructor(tokenId: string) {
    super(`Token details unavailable for ${tokenId}`);
    this.name = 'TokenDetailsUnavailableError';
  }
}

class HyperliquidTokenDetailsClient extends BaseApiService {
  constructor() {
    super((process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info');
  }

  getTokenDetails(tokenId: string): Promise<RawTokenDetails | null> {
    return this.post<RawTokenDetails | null>('', { type: 'tokenDetails', tokenId });
  }
}

export function summarizeTokenDetails(raw: RawTokenDetails): TokenDetailsSummary {
  return {
    name: raw.name,
    maxSupply: raw.maxSupply,
    totalSupply: raw.totalSupply,
    circulatingSupply: raw.circulatingSupply,
    szDecimals: raw.szDecimals,
    weiDecimals: raw.weiDecimals,
    midPx: raw.midPx,
    markPx: raw.markPx,
    prevDayPx: raw.prevDayPx,
    deployer: raw.deployer,
    deployGas: raw.deployGas,
    deployTime: raw.deployTime,
    seededUsdc: raw.seededUsdc,
    futureEmissions: raw.futureEmissions,
    genesisUserCount: raw.genesis?.userBalances?.length ?? 0,
    genesisExistingTokenCount: raw.genesis?.existingTokenBalances?.length ?? 0,
    nonCirculatingUserCount: raw.nonCirculatingUserBalances?.length ?? 0,
  };
}

/**
 * Per token, the live fields of its first spot pair. Hyperliquid's
 * tokenDetails prices a token on that pair (checked 2026-10-13: HYPE on @107,
 * UBTC on @142, AXL on its only pair @252), and every pair of a token carries
 * the same supplies. Contexts are matched to pairs by coin name, as the spot
 * poller does (not by position).
 */
export function liveFieldsByToken(spotMeta: SpotContext, contexts: RawSpotAssetContext[]): Map<number, LiveFields> {
  const contextByCoin = new Map<string, RawSpotAssetContext>();
  for (const ctx of contexts) {
    if (ctx && !contextByCoin.has(ctx.coin)) contextByCoin.set(ctx.coin, ctx);
  }
  const byToken = new Map<number, LiveFields>();
  const pairs = [...spotMeta.universe].sort((a, b) => a.index - b.index);
  for (const pair of pairs) {
    const base = pair.tokens[0];
    const ctx = contextByCoin.get(pair.name);
    if (byToken.has(base) || !ctx) continue;
    byToken.set(base, {
      markPx: ctx.markPx,
      midPx: ctx.midPx ?? null,
      prevDayPx: ctx.prevDayPx,
      circulatingSupply: ctx.circulatingSupply,
      totalSupply: ctx.totalSupply ?? ctx.circulatingSupply,
    });
  }
  return byToken;
}

/**
 * Hyperliquid `tokenDetails` of spot tokens, without the address lists. The
 * browser used to post the info request itself every minute: ~600 B for most
 * tokens, but 5.2 MB for HYPE (its genesis list holds 94k balances, and the
 * info API never compresses) on every /hype page and /market/spot/HYPE, to
 * read one length out of it.
 *
 * What moves (prices, supplies) is laid over every answer from the spot
 * poller's cache, refreshed every 10 s and already paid for. What tokenDetails
 * alone knows (max supply, deploy record, genesis counts, emissions) barely
 * changes, so each token's summary is read from Hyperliquid at most once an
 * hour, kept in Redis for a day (shared by instances, kept across restarts and
 * evictions) and served stale while a refresh runs.
 *
 * The live fields are laid over a summary only when the poller's figures
 * are newer than the summary's own read (`spot:raw_data:updated_at`): if the
 * poller stops, the answer falls back to the summary instead of freezing
 * prices it still calls live.
 *
 * Hyperliquid reads (weight 20 each, out of the backend's 1,200 a minute per
 * IP) are capped at MAX_READS_PER_MINUTE in any 60 s, all tokens together,
 * and only listed spot tokens are read. Refreshes of held summaries (served
 * stale meanwhile, so they never wait) leave RESERVED_FIRST_READS of them to
 * first reads: a crawl or a busy hour over held tokens can't leave cold
 * pages with nothing. A client starts at most MAX_FIRST_READS_PER_CLIENT
 * first reads a minute (a crawler can't spend the budget on its own, a
 * shared IP is not throttled). A token with nothing held waits up to
 * READ_WAIT_MS for a read slot; past it, it gets a partial answer (live
 * fields only) rather than an error. A warmer reads one listed token a
 * minute whose summary is missing or older than WARM_AFTER_MS, so cold pages
 * are rare; a token it failed to read is skipped for WARM_RETRY_AFTER_MS.
 *
 * The read budget is per process: the weight arithmetic below assumes a
 * single backend instance per outbound IP.
 */
export class TokenDetailsService {
  private static instance: TokenDetailsService;

  /** The live fields come from the spot poller: the rest can wait an hour. */
  private static readonly FRESH_MS = 60 * 60_000;
  private static readonly MAX_STALE_MS = 24 * 60 * 60_000;
  /** Tokens whose summary is held in memory (~600 B each; ~500 listed). */
  private static readonly MAX_TOKENS = 1_024;
  /**
   * Hyperliquid reads in any 60 s, all tokens together (weight 20 each → 200
   * a minute, plus the warmer's 20). Worst case of the server IP, out of
   * 1,200 a minute: spot and perp 240 (every 10 s), globalStats 80 (15 s),
   * validators 40 (30 s), spotDeployState 60 (20 s), HLP vault 40 (30 s),
   * positioning up to 160, reserve-yield ledgers ~24, TWAP metas ~4, AF
   * running day ~25 (and its backfill up to 60 after a Redis loss), HIP-4
   * allMids up to 24, bridge-reserve scan up to 60 → ~757, plus 220 here →
   * ~977 (~1,037 during an AF backfill): ~15% left for 5xx retries.
   */
  private static readonly MAX_READS_PER_MINUTE = 10;
  /** Reads of any 60 s that only first reads (nothing held) may take. */
  private static readonly RESERVED_FIRST_READS = 4;
  /** First reads one client may start per minute: a dozen people behind one IP, not a crawl. */
  private static readonly MAX_FIRST_READS_PER_CLIENT = 20;
  /** How long a token with nothing to show waits for a read slot before a partial answer. */
  private static readonly READ_WAIT_MS = 5_000;
  /** Warmer: one read a minute (its own allowance), for summaries missing or older than this. */
  private static readonly WARM_INTERVAL_MS = 60_000;
  private static readonly WARM_AFTER_MS = 6 * 60 * 60_000;
  /** A token the warmer failed to read (null payload, timeout) waits this long before its next try. */
  private static readonly WARM_RETRY_AFTER_MS = 3 * 60 * 60_000;

  private static readonly SPOT_META_CACHE_KEY = 'spot:raw_data';
  /** Epoch ms of the spot poller's last write of SPOT_META_CACHE_KEY. */
  private static readonly SPOT_META_UPDATED_AT_KEY = 'spot:raw_data:updated_at';
  /** The poller rewrites it every 10 s; the live fields served are at most this much older. */
  private static readonly SPOT_STATE_MAX_AGE_MS = 5_000;
  private static readonly STORE_KEY_PREFIX = 'spot:token-details:';

  private readonly client = new HyperliquidTokenDetailsClient();
  private readonly snapshots = new Map<string, OnDemandSnapshot<TokenDetailsSnapshot>>();
  /** `updatedAt`: when the poller wrote what was loaded (null: unknown). */
  private spotState: { tokens: Map<string, SpotTokenState>; loadedAt: number; updatedAt: number | null } | null = null;
  private spotStateLoad: Promise<void> | null = null;
  /** Start times of the Hyperliquid reads of the last 60 s (oldest first). */
  private readLog: number[] = [];
  /** First reads started per client in the current one-minute window. */
  private clientFirstReads = { startedAt: 0, counts: new Map<string, number>() };
  private warmInterval: NodeJS.Timeout | null = null;
  /** When the warmer last failed to read a token, by token id. */
  private warmFailures = new Map<string, number>();

  private constructor() {}

  public static getInstance(): TokenDetailsService {
    if (!TokenDetailsService.instance) {
      TokenDetailsService.instance = new TokenDetailsService();
    }
    return TokenDetailsService.instance;
  }

  /** `tokenId`: 0x + 32 hex digits, any case. `client`: the caller's rate-limit key (IP). */
  public async getTokenDetails(tokenId: string, client: string): Promise<TokenDetailsResult> {
    const id = tokenId.toLowerCase();
    await this.refreshSpotState();
    const token = this.spotState?.tokens.get(id);
    // Fails open (shape check only, done by the route) while the poller hasn't filled Redis.
    if (this.spotState && !token) {
      throw new UnknownTokenIdError(tokenId);
    }

    const snapshot = this.snapshotOf(id);
    await snapshot.hydrate();
    // Nothing held, here or in Redis: this read may go to Hyperliquid, on the client's share.
    const held = snapshot.getFetchedAt() > 0;
    const value = held || this.takeClientFirstRead(client) ? await snapshot.get() : null;
    if (!held && !value) {
      logDeduplicator.warn('Token details: no summary in time, serving the live fields', { tokenId: id });
    }

    if (value) {
      // The poller's figures only when newer than the summary's own read.
      const updatedAt = this.spotState?.updatedAt ?? null;
      const live = updatedAt === null || updatedAt > value.lastUpdate ? token?.live ?? null : null;
      return { details: withLiveFields(value.details, live), lastUpdate: value.lastUpdate, partial: false };
    }
    if (token?.live) {
      return { details: partialDetails(token), lastUpdate: 0, partial: true };
    }
    throw new TokenDetailsUnavailableError(tokenId);
  }

  /** Warmer: one listed token a minute (see the class comment). */
  public startPolling(): void {
    if (this.warmInterval) return;
    this.warmInterval = startGuardedInterval(
      'Token details warmer',
      () => this.warmOne(),
      TokenDetailsService.WARM_INTERVAL_MS
    );
  }

  public stopPolling(): void {
    if (this.warmInterval) {
      clearInterval(this.warmInterval);
      this.warmInterval = null;
    }
  }

  private snapshotOf(tokenId: string): OnDemandSnapshot<TokenDetailsSnapshot> {
    let snapshot = this.snapshots.get(tokenId);
    if (snapshot) {
      // Re-insert: Map order is the recency order.
      this.snapshots.delete(tokenId);
    } else {
      const created: OnDemandSnapshot<TokenDetailsSnapshot> = new OnDemandSnapshot(
        // Nothing held (or expired): a first read, not a refresh.
        () => this.fetchSnapshot(tokenId, created.getFetchedAt() === 0),
        {
          freshMs: TokenDetailsService.FRESH_MS,
          maxStaleMs: TokenDetailsService.MAX_STALE_MS,
          store: this.storeOf(tokenId),
        }
      );
      snapshot = created;
    }
    this.snapshots.set(tokenId, snapshot);

    while (this.snapshots.size > TokenDetailsService.MAX_TOKENS) {
      const [oldest, evicted] = this.snapshots.entries().next().value as [string, OnDemandSnapshot<TokenDetailsSnapshot>];
      evicted.clear();
      this.snapshots.delete(oldest);
    }
    return snapshot;
  }

  private storeOf(tokenId: string): SnapshotStore<TokenDetailsSnapshot> {
    return redisSnapshotStore<TokenDetailsSnapshot>(`${TokenDetailsService.STORE_KEY_PREFIX}${tokenId}`, {
      ttlS: TokenDetailsService.MAX_STALE_MS / 1000,
    });
  }

  /**
   * A first read waits up to READ_WAIT_MS for any slot; a refresh (served
   * stale meanwhile) takes a slot at once or not at all, and stops
   * RESERVED_FIRST_READS short of the cap.
   */
  private async fetchSnapshot(tokenId: string, firstRead: boolean): Promise<TokenDetailsSnapshot> {
    const granted = firstRead
      ? await this.waitForRead(TokenDetailsService.READ_WAIT_MS, TokenDetailsService.MAX_READS_PER_MINUTE)
      : await this.waitForRead(
          0,
          TokenDetailsService.MAX_READS_PER_MINUTE - TokenDetailsService.RESERVED_FIRST_READS
        );
    if (!granted) {
      logDeduplicator.warn('Token details: Hyperliquid read budget spent', { tokenId, firstRead });
      throw new Error('Token details read budget spent');
    }
    return this.readSummary(tokenId);
  }

  private async readSummary(tokenId: string): Promise<TokenDetailsSnapshot> {
    try {
      const raw = await this.client.getTokenDetails(tokenId);
      if (!raw || typeof raw !== 'object') throw new Error('Unexpected tokenDetails payload');
      return { details: summarizeTokenDetails(raw), lastUpdate: Date.now() };
    } catch (error) {
      logDeduplicator.error('Failed to fetch token details', {
        tokenId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** A slot among `limit` reads in any 60 s, waiting at most `maxWaitMs` for one to free up. */
  private async waitForRead(maxWaitMs: number, limit: number): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const now = Date.now();
      while (this.readLog.length > 0 && now - this.readLog[0] >= 60_000) this.readLog.shift();
      if (this.readLog.length < limit) {
        this.readLog.push(now);
        return true;
      }
      // The read that frees a slot for this limit.
      const freeAt = this.readLog[this.readLog.length - limit] + 60_000;
      if (freeAt > deadline) return false;
      // Waiters wake in the order they started waiting (timers with the same due
      // time run in order). Clamped: a clock jump must not overflow the timer.
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.max(1, freeAt - now))));
    }
  }

  /** Fixed one-minute window over each client's first reads (the map is reset with it). */
  private takeClientFirstRead(client: string): boolean {
    const now = Date.now();
    if (now - this.clientFirstReads.startedAt >= 60_000) {
      this.clientFirstReads = { startedAt: now, counts: new Map() };
    }
    const count = this.clientFirstReads.counts.get(client) ?? 0;
    if (count >= TokenDetailsService.MAX_FIRST_READS_PER_CLIENT) return false;
    this.clientFirstReads.counts.set(client, count + 1);
    return true;
  }

  /**
   * One read a minute across instances (a claim per minute in Redis): the
   * first listed token with no stored summary, else the one whose summary is
   * the oldest past WARM_AFTER_MS. A token this process failed to read within
   * WARM_RETRY_AFTER_MS is skipped, so one token that always fails (null
   * payload, timeout) can't stall the warmer on itself.
   */
  private async warmOne(): Promise<void> {
    await this.refreshSpotState();
    const ids = [...(this.spotState?.tokens.keys() ?? [])];
    if (ids.length === 0) return;
    const claimed = await redisService.claimKeys(
      [`${TokenDetailsService.STORE_KEY_PREFIX}warm:${Math.floor(Date.now() / TokenDetailsService.WARM_INTERVAL_MS)}`],
      Math.ceil((2 * TokenDetailsService.WARM_INTERVAL_MS) / 1000)
    );
    if (claimed && !claimed[0]) return;

    const stored = await redisService.mget(ids.map((id) => `${TokenDetailsService.STORE_KEY_PREFIX}${id}`));
    if (!stored) return;
    const now = Date.now();
    for (const [id, failedAt] of this.warmFailures) {
      if (now - failedAt >= TokenDetailsService.WARM_RETRY_AFTER_MS) this.warmFailures.delete(id);
    }
    let target: string | null = null;
    let oldest = now - TokenDetailsService.WARM_AFTER_MS;
    for (let i = 0; i < ids.length; i++) {
      if (this.warmFailures.has(ids[i])) continue;
      const raw = stored[i];
      if (!raw) {
        target = ids[i];
        break;
      }
      const fetchedAt = storedFetchedAt(raw);
      if (fetchedAt < oldest) {
        oldest = fetchedAt;
        target = ids[i];
      }
    }
    if (!target) return;

    let snapshot: TokenDetailsSnapshot;
    try {
      snapshot = await this.readSummary(target);
    } catch (error) {
      this.warmFailures.set(target, Date.now());
      throw error;
    }
    this.warmFailures.delete(target);
    await this.storeOf(target).save(snapshot, snapshot.lastUpdate);
  }

  /**
   * The listed tokens and their live fields, from the spot poller's cache,
   * at most SPOT_STATE_MAX_AGE_MS old. Concurrent callers share one load.
   */
  private async refreshSpotState(): Promise<void> {
    const age = this.spotState ? Date.now() - this.spotState.loadedAt : Infinity;
    if (age <= TokenDetailsService.SPOT_STATE_MAX_AGE_MS) return;
    if (!this.spotStateLoad) {
      this.spotStateLoad = this.readSpotState().finally(() => {
        this.spotStateLoad = null;
      });
    }
    await this.spotStateLoad;
  }

  private async readSpotState(): Promise<void> {
    try {
      const [raw, rawUpdatedAt] = await Promise.all([
        redisService.get(TokenDetailsService.SPOT_META_CACHE_KEY),
        redisService.get(TokenDetailsService.SPOT_META_UPDATED_AT_KEY),
      ]);
      if (!raw) return;
      const updatedAt = rawUpdatedAt === null ? Number.NaN : Number(rawUpdatedAt);
      const [spotMeta, contexts] = JSON.parse(raw) as [SpotContext, RawSpotAssetContext[]];
      const live = liveFieldsByToken(spotMeta, contexts ?? []);
      const tokens = new Map<string, SpotTokenState>();
      for (const t of spotMeta.tokens) {
        tokens.set(t.tokenId.toLowerCase(), {
          name: t.name,
          szDecimals: t.szDecimals,
          weiDecimals: t.weiDecimals,
          live: live.get(t.index) ?? null,
        });
      }
      this.spotState = { tokens, loadedAt: Date.now(), updatedAt: Number.isFinite(updatedAt) ? updatedAt : null };
    } catch (error) {
      logDeduplicator.warn('TokenDetailsService: failed to load the spot tokens', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function withLiveFields(details: TokenDetailsSummary, live: LiveFields | null): TokenDetailsSummary {
  return live ? { ...details, ...live } : details;
}

function partialDetails(token: SpotTokenState): TokenDetailsPartial {
  return {
    name: token.name,
    maxSupply: null,
    totalSupply: token.live?.totalSupply ?? null,
    circulatingSupply: token.live?.circulatingSupply ?? null,
    szDecimals: token.szDecimals,
    weiDecimals: token.weiDecimals,
    midPx: token.live?.midPx ?? null,
    markPx: token.live?.markPx ?? null,
    prevDayPx: token.live?.prevDayPx ?? null,
    deployer: null,
    deployGas: null,
    deployTime: null,
    seededUsdc: null,
    futureEmissions: null,
    genesisUserCount: null,
    genesisExistingTokenCount: null,
    nonCirculatingUserCount: null,
  };
}

/** Fetch time of a stored summary (redisSnapshotStore's JSON), 0 when unreadable. */
function storedFetchedAt(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown };
    return typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
  } catch {
    return 0;
  }
}
