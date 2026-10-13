import { BaseApiService } from '../../core/base.api.service';
import { redisService } from '../../core/redis.service';
import { AssetContext, SpotContext } from '../../types/market.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { startGuardedInterval } from '../../utils/guardedInterval';

/** `tokenDetails`, the fields read here. */
interface RawTokenGenesis {
  genesis: { userBalances?: [string, string][] } | null;
  nonCirculatingUserBalances?: [string, string][];
}

/** `spotClearinghouseState`, the fields read here. */
interface RawSpotBalances {
  balances?: { coin: string; token: number; total: string }[];
}

/**
 * What a token's system address holds:
 * - 'reserve': a bridge reserve, not coins in circulation. The genesis
 *   credited the address, or the genesis' only holder later parked (nearly)
 *   the whole supply there;
 * - 'watch': the genesis credited one other address, which may still park the
 *   supply there (issuers of tokenized stocks did, after genesis);
 * - 'none': coins users moved to HyperEVM, which circulate there (tokens that
 *   start on HyperCore).
 */
export type SystemAddressRole = 'reserve' | 'watch' | 'none';

/** What is kept per token, in memory and in Redis. */
export interface StoredBridgeReserve {
  role: SystemAddressRole;
  /** HyperCore balance of the system address, once read ('reserve' and 'watch'). */
  balance?: number;
  /** Epoch ms of that read. */
  balanceReadAt?: number;
}

interface ListedToken {
  tokenId: string;
  index: number;
  name: string;
  /** Circulating supply as Hyperliquid reports it. */
  circulating: number;
  /** Mark price × that supply, largest pair: the genesis read order. */
  reportedCap: number;
}

const ROLES: readonly SystemAddressRole[] = ['reserve', 'watch', 'none'];

/**
 * HyperEVM system address of spot token `index`: 0x20, zeros, then the index
 * in hex. (HYPE's is 0x2222…2222; HYPE is never read here.)
 */
export function systemAddressOf(index: number): string {
  return '0x20' + index.toString(16).padStart(38, '0');
}

/** The role a token's genesis gives its system address. */
export function classifyGenesis(details: RawTokenGenesis, systemAddress: string): SystemAddressRole {
  // Hyperliquid already leaves it out of the circulating supply.
  if ((details.nonCirculatingUserBalances ?? []).some(([address]) => address.toLowerCase() === systemAddress)) {
    return 'none';
  }
  const credits = (details.genesis?.userBalances ?? []).filter(([, amount]) => Number(amount) > 0);
  if (credits.some(([address]) => address.toLowerCase() === systemAddress)) return 'reserve';
  return credits.length === 1 ? 'watch' : 'none';
}

class HyperliquidReserveClient extends BaseApiService {
  constructor() {
    super((process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info');
  }

  tokenDetails(tokenId: string): Promise<RawTokenGenesis | null> {
    return this.post<RawTokenGenesis | null>('', { type: 'tokenDetails', tokenId });
  }

  spotClearinghouseState(user: string): Promise<RawSpotBalances | null> {
    return this.post<RawSpotBalances | null>('', { type: 'spotClearinghouseState', user });
  }
}

/**
 * Bridge reserves parked on the HyperEVM system address of spot tokens.
 *
 * A spot token linked to HyperEVM crosses between the two sides through its
 * system address. Tokens that come from HyperEVM (USDT0, XAUT0, kHYPE, AXL…)
 * put their whole supply on that address at genesis, most of them 2^64 - 1
 * units, and HyperCore pays bridged-in tokens out of it. Issuers of tokenized
 * stocks (AAPL, MSFT…) minted to themselves, then parked it all there.
 * Hyperliquid counts that reserve as circulating, so mark price ×
 * circulatingSupply priced XAUT0 at $770,000B for ~4,000 XAUT0 on HyperCore,
 * and AAPL at $4,250B for 18. The spot poller subtracts the reserve read here.
 *
 * - The genesis of each listed token is read once (`tokenDetails`, weight
 *   20), largest reported cap first: it never changes, so the role it gives
 *   the system address is kept in Redis for good.
 * - The system address's HyperCore balance (`spotClearinghouseState`, weight
 *   2) is read when the role is found, then every RESERVE_REFRESH_MS for a
 *   reserve and every WATCH_REFRESH_MS for a watched token. A watched token
 *   becomes a reserve, for good, once the address holds PARKED_SHARE of the
 *   circulating supply.
 * - A cycle spends MAX_WEIGHT_PER_CYCLE at most: the other pollers already use
 *   about half of Hyperliquid's 1,200 a minute per IP.
 *
 * Tokens that start on HyperCore (HYPE, PURR…) are left alone: their system
 * address holds what users moved to HyperEVM (35% of the supply at most on
 * 2026-10-09), which circulates there.
 */
export class SpotBridgeReserveService {
  private static instance: SpotBridgeReserveService;

  private static readonly STORE_KEY = 'spot:bridge-reserve:v1';
  private static readonly SPOT_META_CACHE_KEY = 'spot:raw_data';
  private static readonly CYCLE_MS = 60_000;
  /** Hyperliquid weight spent per cycle at most. */
  private static readonly MAX_WEIGHT_PER_CYCLE = 180;
  private static readonly GENESIS_WEIGHT = 20;
  private static readonly BALANCE_WEIGHT = 2;
  private static readonly RESERVE_REFRESH_MS = 5 * 60_000;
  private static readonly WATCH_REFRESH_MS = 30 * 60_000;
  /** Share of the circulating supply on the system address that makes a watched token's balance a reserve. */
  private static readonly PARKED_SHARE = 0.99;
  /** A token whose genesis read failed waits this long before the next try. */
  private static readonly GENESIS_RETRY_MS = 10 * 60_000;

  private readonly client = new HyperliquidReserveClient();
  private readonly tokens = new Map<string, StoredBridgeReserve>();
  /** After a failed read, the token's next try of that read (a failure also ends the cycle). */
  private readonly genesisRetryAt = new Map<string, number>();
  private readonly balanceRetryAt = new Map<string, number>();
  private storeLoad: Promise<boolean> | null = null;
  /** A change whose save was skipped (Redis unreadable): saved on the next cycle. */
  private unsaved = false;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): SpotBridgeReserveService {
    if (!SpotBridgeReserveService.instance) {
      SpotBridgeReserveService.instance = new SpotBridgeReserveService();
    }
    return SpotBridgeReserveService.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Bridge reserve polling already started');
      return;
    }
    logDeduplicator.info('Starting bridge reserve polling');
    this.pollingInterval = startGuardedInterval(
      'Bridge reserve polling',
      () => this.runCycle(),
      SpotBridgeReserveService.CYCLE_MS
    );
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Bridge reserve polling stopped');
    }
  }

  /**
   * The kept roles and balances, from Redis, once it could be read: while
   * Redis is unreadable the next call tries again. True once loaded.
   */
  public load(): Promise<boolean> {
    if (!this.storeLoad) {
      this.storeLoad = this.readStore().then((stored) => {
        if (!stored) {
          this.storeLoad = null;
          return false;
        }
        this.adopt(stored);
        return true;
      });
    }
    return this.storeLoad;
  }

  /**
   * HyperCore balance held by the token's system address as a bridge reserve:
   * 0 for tokens without one, and until both reads are done.
   */
  public reserveOf(tokenId: string): number {
    const token = this.tokens.get(tokenId);
    return token?.role === 'reserve' && token.balance !== undefined ? token.balance : 0;
  }

  private async runCycle(): Promise<void> {
    // Without the stored roles every token would look unclassified: no rescan.
    if (!(await this.load())) return;
    const listed = await this.readListedTokens();
    if (!listed) return;

    const now = Date.now();
    let budget = SpotBridgeReserveService.MAX_WEIGHT_PER_CYCLE;
    let changed = false;

    try {
      // Balances due, oldest first.
      const due = listed
        .filter((t) => {
          const stored = this.tokens.get(t.tokenId);
          if (!stored || stored.role === 'none') return false;
          const every =
            stored.role === 'reserve' ? SpotBridgeReserveService.RESERVE_REFRESH_MS : SpotBridgeReserveService.WATCH_REFRESH_MS;
          return now - (stored.balanceReadAt ?? 0) >= every && (this.balanceRetryAt.get(t.tokenId) ?? 0) <= now;
        })
        .sort((a, b) => (this.tokens.get(a.tokenId)?.balanceReadAt ?? 0) - (this.tokens.get(b.tokenId)?.balanceReadAt ?? 0));
      for (const token of due) {
        if (budget < SpotBridgeReserveService.BALANCE_WEIGHT) return;
        budget -= SpotBridgeReserveService.BALANCE_WEIGHT;
        if (!(await this.readBalance(token))) return;
        changed = true;
      }

      // Genesis of the tokens not classified yet; the balance is read at once.
      const unclassified = listed
        .filter((t) => !this.tokens.has(t.tokenId) && (this.genesisRetryAt.get(t.tokenId) ?? 0) <= now)
        .sort((a, b) => b.reportedCap - a.reportedCap);
      for (const token of unclassified) {
        // HyperCore's own token: its system address (0x2222…) holds the HYPE
        // moved to HyperEVM, and its tokenDetails weighs 5 MB. Not read.
        if (token.name === 'HYPE') {
          this.tokens.set(token.tokenId, { role: 'none' });
          changed = true;
          continue;
        }
        if (budget < SpotBridgeReserveService.GENESIS_WEIGHT + SpotBridgeReserveService.BALANCE_WEIGHT) return;
        budget -= SpotBridgeReserveService.GENESIS_WEIGHT;
        const role = await this.readGenesis(token);
        if (role === null) return;
        this.tokens.set(token.tokenId, { role });
        changed = true;
        if (role !== 'none') {
          budget -= SpotBridgeReserveService.BALANCE_WEIGHT;
          if (!(await this.readBalance(token))) return;
        }
      }
    } finally {
      if (changed || this.unsaved) await this.saveStore();
    }
  }

  /** The role the genesis gives the token's system address; null when it can't be read now. */
  private async readGenesis(token: ListedToken): Promise<SystemAddressRole | null> {
    try {
      const details = await this.client.tokenDetails(token.tokenId);
      if (!details || typeof details !== 'object') throw new Error('Unexpected tokenDetails payload');
      this.genesisRetryAt.delete(token.tokenId);
      return classifyGenesis(details, systemAddressOf(token.index));
    } catch (error) {
      this.genesisRetryAt.set(token.tokenId, Date.now() + SpotBridgeReserveService.GENESIS_RETRY_MS);
      logDeduplicator.warn('Bridge reserve: genesis read failed', {
        token: token.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Reads the system address's balance of the token; false when it can't be read now. */
  private async readBalance(token: ListedToken): Promise<boolean> {
    const stored = this.tokens.get(token.tokenId);
    if (!stored) return false;
    try {
      const state = await this.client.spotClearinghouseState(systemAddressOf(token.index));
      if (!state || !Array.isArray(state.balances)) throw new Error('Unexpected spotClearinghouseState payload');
      const held = state.balances.find((b) => b.token === token.index);
      const balance = held ? Number(held.total) : 0;
      if (!Number.isFinite(balance) || balance < 0) throw new Error(`Unexpected balance ${held?.total}`);
      stored.balance = balance;
      stored.balanceReadAt = Date.now();
      this.balanceRetryAt.delete(token.tokenId);
      if (
        stored.role === 'watch' &&
        token.circulating > 0 &&
        balance >= SpotBridgeReserveService.PARKED_SHARE * token.circulating
      ) {
        stored.role = 'reserve';
        logDeduplicator.info('Bridge reserve: supply parked on the system address', {
          token: token.name,
          balance,
          circulating: token.circulating,
        });
      }
      return true;
    } catch (error) {
      this.balanceRetryAt.set(token.tokenId, Date.now() + SpotBridgeReserveService.RESERVE_REFRESH_MS);
      logDeduplicator.warn('Bridge reserve: balance read failed', {
        token: token.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Base tokens of the listed pairs, from the spot poller's cache; null until it has written it. */
  private async readListedTokens(): Promise<ListedToken[] | null> {
    try {
      const raw = await redisService.get(SpotBridgeReserveService.SPOT_META_CACHE_KEY);
      if (!raw) return null;
      const [meta, contexts] = JSON.parse(raw) as [SpotContext, AssetContext[]];
      const byIndex = new Map(meta.tokens.map((t) => [t.index, t]));
      const contextByCoin = new Map(contexts.map((c) => [c.coin, c]));
      const listed = new Map<string, ListedToken>();
      for (const market of meta.universe) {
        const token = byIndex.get(market.tokens[0]);
        if (!token) continue;
        const ctx = contextByCoin.get(market.name);
        const supply = ctx ? Number(ctx.circulatingSupply) : 0;
        const circulating = Number.isFinite(supply) ? supply : 0;
        const cap = ctx ? Number(ctx.markPx) * circulating : 0;
        const reportedCap = Number.isFinite(cap) ? cap : 0;
        const known = listed.get(token.tokenId);
        if (known) {
          known.circulating = Math.max(known.circulating, circulating);
          known.reportedCap = Math.max(known.reportedCap, reportedCap);
        } else {
          listed.set(token.tokenId, { tokenId: token.tokenId, index: token.index, name: token.name, circulating, reportedCap });
        }
      }
      return [...listed.values()];
    } catch (error) {
      logDeduplicator.error('Bridge reserve: spot meta unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The stored roles and balances; empty when nothing is stored, null when
   * Redis can't be read (mget tells the two apart, get doesn't).
   */
  private async readStore(): Promise<Map<string, StoredBridgeReserve> | null> {
    const values = await redisService.mget([SpotBridgeReserveService.STORE_KEY]);
    if (!values) return null;
    const stored = new Map<string, StoredBridgeReserve>();
    const raw = values[0];
    if (!raw) return stored;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [tokenId, value] of Object.entries(parsed)) {
        const v = value as Partial<StoredBridgeReserve> | null;
        if (typeof v !== 'object' || v === null || !ROLES.includes(v.role as SystemAddressRole)) continue;
        const entry: StoredBridgeReserve = { role: v.role as SystemAddressRole };
        if (Number.isFinite(v.balance) && (v.balance as number) >= 0 && Number.isFinite(v.balanceReadAt)) {
          entry.balance = v.balance;
          entry.balanceReadAt = v.balanceReadAt;
        }
        stored.set(tokenId, entry);
      }
    } catch (error) {
      logDeduplicator.error('Bridge reserve: stored state unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return stored;
  }

  /** Stored entries for the tokens not held in memory (what memory holds is newer). */
  private adopt(stored: Map<string, StoredBridgeReserve>): void {
    for (const [tokenId, entry] of stored) {
      if (!this.tokens.has(tokenId)) this.tokens.set(tokenId, entry);
    }
  }

  /**
   * Merged with what Redis holds, and skipped while Redis can't be read: a
   * partial map never replaces the stored one.
   */
  private async saveStore(): Promise<void> {
    const stored = await this.readStore();
    if (!stored) {
      this.unsaved = true;
      logDeduplicator.warn('Bridge reserve: Redis unreadable, save postponed');
      return;
    }
    this.adopt(stored);
    // No expiry: roles never go back, and an old balance beats none.
    await redisService.set(SpotBridgeReserveService.STORE_KEY, JSON.stringify(Object.fromEntries(this.tokens)));
    this.unsaved = false;
  }
}
