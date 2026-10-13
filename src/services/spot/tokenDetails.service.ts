import { BaseApiService } from '../../core/base.api.service';
import { redisService } from '../../core/redis.service';
import { AssetContext, SpotContext } from '../../types/market.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { OnDemandSnapshot } from '../../utils/onDemandSnapshot';

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
 * Hyperliquid `tokenDetails` of spot tokens, without the address lists. The
 * browser used to post the info request itself every minute: ~600 B for most
 * tokens, but 5.2 MB for HYPE (its genesis list holds 94k balances, and the
 * info API never compresses) on every /hype page and /market/spot/HYPE, to
 * read one length out of it.
 *
 * One OnDemandSnapshot per token, read from Hyperliquid at most once per
 * FRESH_MS whatever the number of readers. Only listed spot tokens are read,
 * and at most MAX_READS_PER_MINUTE times a minute in all: a crawl through
 * every token id can't spend the backend's Hyperliquid weight budget (20 per
 * read, 1200 a minute per IP). Within that budget:
 * - refreshes of held summaries leave RESERVED_FIRST_READS to first reads:
 *   a held summary can wait (it is served stale for MAX_STALE_MS), a token
 *   page with nothing to show can't;
 * - one client starts at most MAX_FIRST_READS_PER_CLIENT first reads a
 *   minute, so a single crawler can't leave the other pages with nothing.
 */
export class TokenDetailsService {
  private static instance: TokenDetailsService;

  /** The front polls every minute. */
  private static readonly FRESH_MS = 60_000;
  private static readonly MAX_STALE_MS = 10 * 60_000;
  /** Tokens whose summary is held at once; the least recently read one goes first. */
  private static readonly MAX_TOKENS = 64;
  /**
   * Hyperliquid reads allowed per minute, all tokens together (weight 20
   * each). Worst case of the server IP, out of 1,200 a minute: the pollers
   * spend ~720 (spot, perp, validatorSummaries and globalStats at 20 every
   * 10 s = 480, HLP vault 60, positioning up to 160, reserve-yield ledger
   * 20), the bridge-reserve scan up to 180, the TWAP metas and the AF running
   * day ~40: 940, plus 10 x 20 = 200 here → 1,140. (The AF buyback backfill,
   * up to 300 a minute while missing days are read after a cold Redis, is a
   * one-off on top.)
   */
  private static readonly MAX_READS_PER_MINUTE = 10;
  /** Reads of the minute only first reads (no summary held) may take. */
  private static readonly RESERVED_FIRST_READS = 4;
  /** First reads one client may start per minute. */
  private static readonly MAX_FIRST_READS_PER_CLIENT = 3;

  private static readonly SPOT_META_CACHE_KEY = 'spot:raw_data';
  private static readonly KNOWN_TOKENS_TTL_MS = 60_000;
  /** A token id missing from the list reloads it once it is this old (new listings). */
  private static readonly KNOWN_TOKENS_MIN_RELOAD_MS = 10_000;

  private readonly client = new HyperliquidTokenDetailsClient();
  private readonly snapshots = new Map<string, OnDemandSnapshot<TokenDetailsSnapshot>>();
  private knownTokens: { ids: Set<string>; loadedAt: number } | null = null;
  private knownTokensLoad: Promise<void> | null = null;
  private readsWindow = { startedAt: 0, count: 0 };
  /** First reads started per client in the current one-minute window. */
  private clientFirstReads = { startedAt: 0, counts: new Map<string, number>() };

  private constructor() {}

  public static getInstance(): TokenDetailsService {
    if (!TokenDetailsService.instance) {
      TokenDetailsService.instance = new TokenDetailsService();
    }
    return TokenDetailsService.instance;
  }

  /** `tokenId`: 0x + 32 hex digits, any case. `client`: the caller's rate-limit key (IP). */
  public async getTokenDetails(tokenId: string, client: string): Promise<TokenDetailsSnapshot> {
    const id = tokenId.toLowerCase();
    if (!(await this.isKnownToken(id))) {
      throw new UnknownTokenIdError(tokenId);
    }

    // No summary held: this read may go to Hyperliquid, on the client's share.
    const held = this.snapshots.get(id);
    if (!held?.getFetchedAt() && !this.takeClientFirstRead(client)) {
      logDeduplicator.warn('Token details: first-read share of a client spent for this minute', { tokenId: id });
      throw new TokenDetailsUnavailableError(tokenId);
    }

    const snapshot = await this.snapshotOf(id).get();
    if (!snapshot) {
      throw new TokenDetailsUnavailableError(tokenId);
    }
    return snapshot;
  }

  private snapshotOf(tokenId: string): OnDemandSnapshot<TokenDetailsSnapshot> {
    let snapshot = this.snapshots.get(tokenId);
    if (snapshot) {
      // Re-insert: Map order is the recency order.
      this.snapshots.delete(tokenId);
    } else {
      const created: OnDemandSnapshot<TokenDetailsSnapshot> = new OnDemandSnapshot(
        // Nothing held yet (or expired): a first read, not a refresh.
        () => this.fetchSnapshot(tokenId, created.getFetchedAt() === 0),
        {
          freshMs: TokenDetailsService.FRESH_MS,
          maxStaleMs: TokenDetailsService.MAX_STALE_MS,
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

  private async fetchSnapshot(tokenId: string, firstRead: boolean): Promise<TokenDetailsSnapshot> {
    if (!this.takeRead(firstRead)) {
      logDeduplicator.warn('Token details: Hyperliquid read budget spent for this minute', { tokenId, firstRead });
      throw new Error('Token details read budget spent');
    }
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

  /**
   * Fixed one-minute window over every token's Hyperliquid reads; refreshes
   * stop RESERVED_FIRST_READS short of the cap.
   */
  private takeRead(firstRead: boolean): boolean {
    const now = Date.now();
    if (now - this.readsWindow.startedAt >= 60_000) {
      this.readsWindow = { startedAt: now, count: 0 };
    }
    const cap = firstRead
      ? TokenDetailsService.MAX_READS_PER_MINUTE
      : TokenDetailsService.MAX_READS_PER_MINUTE - TokenDetailsService.RESERVED_FIRST_READS;
    if (this.readsWindow.count >= cap) return false;
    this.readsWindow.count++;
    return true;
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
   * Whether `tokenId` (lowercased) is in the spot meta the spot poller caches
   * in Redis. Fails open (shape check only, done by the route) while the
   * poller hasn't filled Redis yet.
   */
  private async isKnownToken(tokenId: string): Promise<boolean> {
    const age = this.knownTokens ? Date.now() - this.knownTokens.loadedAt : Infinity;
    if (age > TokenDetailsService.KNOWN_TOKENS_TTL_MS) {
      await this.loadKnownTokens();
    } else if (
      !this.knownTokens?.ids.has(tokenId) &&
      age > TokenDetailsService.KNOWN_TOKENS_MIN_RELOAD_MS
    ) {
      await this.loadKnownTokens();
    }
    if (!this.knownTokens) return true;
    return this.knownTokens.ids.has(tokenId);
  }

  /** Concurrent callers share one load. */
  private loadKnownTokens(): Promise<void> {
    if (!this.knownTokensLoad) {
      this.knownTokensLoad = this.readKnownTokens().finally(() => {
        this.knownTokensLoad = null;
      });
    }
    return this.knownTokensLoad;
  }

  private async readKnownTokens(): Promise<void> {
    try {
      const raw = await redisService.get(TokenDetailsService.SPOT_META_CACHE_KEY);
      if (!raw) return;
      const [spotMeta] = JSON.parse(raw) as [SpotContext, AssetContext[]];
      this.knownTokens = {
        ids: new Set(spotMeta.tokens.map((t) => t.tokenId.toLowerCase())),
        loadedAt: Date.now(),
      };
    } catch (error) {
      logDeduplicator.warn('TokenDetailsService: failed to load the spot tokens', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
