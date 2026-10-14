import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../../clients/hypedexer/rest/shared/hypedexer-api.config';
import { redisService } from '../../core/redis.service';
import { cacheService } from '../../core/cache.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import type { LeaderboardResponse } from '../../types/leaderboard.types';

/**
 * Hyperliquid portfolio margin: borrow/lend reserves and the accounts that
 * use them.
 *
 * Hyperliquid has no list of portfolio margin accounts, so we find them: the
 * leaderboard (already cached by HyperliquidLeaderboardClient) gives every
 * account with a balance, and each eligible one (account value between $10k
 * and $25M, the documented eligibility caps) is checked once with
 * `userAbstraction`. Found accounts are refreshed with `borrowLendUserState`
 * and `clearinghouseState`: borrowers every 5 min, the others every 30 min.
 *
 * Every per-account call goes through the HypeDexer /info proxy (3 credits a
 * call), never api.hyperliquid.xyz, so the scan costs nothing against our
 * Hyperliquid IP weight budget. Health and healthFactor are Hyperliquid's own
 * values, passed through untouched.
 */

const INFO_URL = `${HYPEDEXER_API_URL}/info`;
const LEADERBOARD_KEY = 'leaderboard:data';
const ACCOUNTS_KEY = 'pm:accounts';
const SCANNED_KEY = 'pm:scanned';
const ACCOUNTS_TTL_S = 7 * 24 * 3600;

const MIN_ACCOUNT_VALUE = 10_000;
const MAX_ACCOUNT_VALUE = 25_000_000;
/** Accounts checked per scan tick (one tick a minute). */
const SCAN_PER_TICK = Number(process.env.PM_SCAN_PER_MIN || 120);
/** A checked account is checked again after this long (people switch modes). */
const RESCAN_AFTER_MS = 3 * 24 * 3600 * 1000;
/** Borrowers are re-read every 5 min, accounts without debt every 30 min (3 credits a call, 2 calls an account). */
const REFRESH_EVERY_MS = 5 * 60 * 1000;
const IDLE_REFRESH_EVERY_MS = 30 * 60 * 1000;
/** HypeDexer starts answering 429 past a few calls in flight per key. */
const CONCURRENCY = 2;
const TIMEOUT_MS = 10_000;

type ReserveState = {
  borrowYearlyRate: string;
  supplyYearlyRate: string;
  balance: string;
  utilization: string;
  oraclePx: string;
  ltv: string;
  totalSupplied: string;
  totalBorrowed: string;
};

type BorrowLendUserState = {
  tokenToState: [number, { borrow: { value: string }; supply: { value: string } }][];
  health: string;
  healthFactor: string | null;
};

type ClearinghouseState = {
  marginSummary: { accountValue: string; totalNtlPos: string };
  crossMaintenanceMarginUsed: string;
  assetPositions: { position: { coin: string; szi: string; positionValue: string; unrealizedPnl: string } }[];
};

export interface PmReserve {
  token: number;
  name: string;
  oraclePx: number;
  /** Loan-to-value of the token as collateral (0 = not collateral). */
  ltv: number;
  /** Documented liquidation threshold: 0.5 + 0.5 * LTV, only meaningful when LTV > 0. */
  liquidationThreshold: number | null;
  totalSupplied: number;
  totalBorrowed: number;
  suppliedUsd: number;
  borrowedUsd: number;
  utilization: number;
  borrowApy: number;
  supplyApy: number;
}

export interface PmTokenAmount {
  token: number;
  name: string;
  amount: number;
  usd: number;
}

export interface PmAccount {
  address: string;
  health: string;
  healthFactor: number | null;
  debtUsd: number;
  collateralUsd: number;
  borrows: PmTokenAmount[];
  supplies: PmTokenAmount[];
  perpAccountValue: number;
  perpMaintenanceMargin: number;
  perps: { coin: string; size: number; notionalUsd: number; unrealizedPnl: number }[];
  updatedAt: number;
}

export interface PmSnapshot {
  reserves: PmReserve[];
  accounts: PmAccount[];
  scan: { candidates: number; checked: number; found: number };
  updatedAt: number;
}

async function info<T>(body: Record<string, unknown>, attempt = 0): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: hypedexerJsonHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // HypeDexer answers bursts with 429 + Retry-After (seconds); errors cost no credits.
  if (res.status === 429 && attempt < 2) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 5) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return info<T>(body, attempt + 1);
  }
  if (!res.ok) throw new Error(`HypeDexer /info ${String(body.type)} ${res.status}`);
  return (await res.json()) as T;
}

/** Run `fn` over `items` with at most `limit` calls in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

const num = (v: string | null | undefined) => (v == null ? 0 : Number(v));

export class PortfolioMarginService {
  private static instance: PortfolioMarginService;

  /** address -> { mode, checkedAt }. In memory: a restart re-scans (about 140k credits for the whole leaderboard). */
  private readonly scanned = new Map<string, { mode: string; at: number }>();
  private accounts = new Map<string, PmAccount>();
  private candidates = 0;
  private lastRefresh = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public static getInstance(): PortfolioMarginService {
    if (!PortfolioMarginService.instance) PortfolioMarginService.instance = new PortfolioMarginService();
    return PortfolioMarginService.instance;
  }

  public startPolling(): void {
    if (process.env.PM_SCAN_ENABLED === 'false') {
      logDeduplicator.info('Portfolio margin scan disabled (PM_SCAN_ENABLED=false)');
      return;
    }
    if (this.timer) return;
    void this.restore();
    // The leaderboard poller fills its cache within the first minute.
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  public stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reload the accounts and the scan progress saved before the last restart. */
  private async restore(): Promise<void> {
    try {
      const [accounts, scanned] = await Promise.all([redisService.get(ACCOUNTS_KEY), redisService.get(SCANNED_KEY)]);
      if (accounts) for (const a of JSON.parse(accounts) as PmAccount[]) this.accounts.set(a.address, a);
      if (scanned) for (const [addr, v] of Object.entries(JSON.parse(scanned) as Record<string, { mode: string; at: number }>)) this.scanned.set(addr, v);
    } catch (err) {
      logDeduplicator.warn('Portfolio margin restore failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.scanBatch();
      if (Date.now() - this.lastRefresh >= REFRESH_EVERY_MS) await this.refreshAccounts();
    } catch (err) {
      logDeduplicator.error('Portfolio margin tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }

  /** Check the account mode of the next eligible leaderboard accounts, largest first. */
  private async scanBatch(): Promise<void> {
    const raw = await redisService.get(LEADERBOARD_KEY);
    if (!raw) return;
    const rows = (JSON.parse(raw) as LeaderboardResponse).leaderboardRows;
    const eligible = rows
      .map((r) => ({ address: r.ethAddress.toLowerCase(), value: Number(r.accountValue) }))
      .filter((r) => r.value >= MIN_ACCOUNT_VALUE && r.value <= MAX_ACCOUNT_VALUE)
      .sort((a, b) => b.value - a.value);
    this.candidates = eligible.length;

    const now = Date.now();
    const due = eligible.filter((r) => {
      const s = this.scanned.get(r.address);
      return !s || now - s.at > RESCAN_AFTER_MS;
    });
    const batch = due.slice(0, SCAN_PER_TICK);
    if (!batch.length) return;

    const modes = await pool(batch, CONCURRENCY, async (r) => {
      try {
        return await info<string>({ type: 'userAbstraction', user: r.address });
      } catch {
        return null;
      }
    });
    let found = 0;
    batch.forEach((r, i) => {
      const mode = modes[i];
      if (mode == null) return; // retried next tick
      this.scanned.set(r.address, { mode, at: now });
      if (mode === 'portfolioMargin' && !this.accounts.has(r.address)) {
        found++;
        this.lastRefresh = 0; // fetch the new account's state this tick
      }
      if (mode !== 'portfolioMargin' && this.accounts.has(r.address)) this.accounts.delete(r.address);
    });
    for (const [addr, s] of this.scanned) if (s.mode === 'portfolioMargin' && !this.accounts.has(addr)) this.accounts.set(addr, this.placeholder(addr));
    if (found) logDeduplicator.info('Portfolio margin accounts found', { found, total: this.accounts.size });
    await redisService.set(SCANNED_KEY, JSON.stringify(Object.fromEntries(this.scanned)), ACCOUNTS_TTL_S);
  }

  private placeholder(address: string): PmAccount {
    return {
      address, health: 'unknown', healthFactor: null, debtUsd: 0, collateralUsd: 0, borrows: [], supplies: [],
      perpAccountValue: 0, perpMaintenanceMargin: 0, perps: [], updatedAt: 0,
    };
  }

  /** Re-read the borrow/lend state and perp positions of every known portfolio margin account. */
  private async refreshAccounts(): Promise<void> {
    if (!this.accounts.size) return;
    const reserves = await this.getReserves();
    const byToken = new Map(reserves.map((r) => [r.token, r]));
    const now = Date.now();
    const addresses = [...this.accounts.values()]
      .filter((a) => a.debtUsd > 0 || now - a.updatedAt >= IDLE_REFRESH_EVERY_MS)
      .map((a) => a.address);
    const fresh = await pool(addresses, CONCURRENCY, async (address) => {
      try {
        const [bl, ch] = await Promise.all([
          info<BorrowLendUserState>({ type: 'borrowLendUserState', user: address }),
          info<ClearinghouseState>({ type: 'clearinghouseState', user: address }),
        ]);
        return this.toAccount(address, bl, ch, byToken);
      } catch {
        return null; // keep the previous state
      }
    });
    fresh.forEach((a) => a && this.accounts.set(a.address, a));
    this.lastRefresh = Date.now();
    await redisService.set(ACCOUNTS_KEY, JSON.stringify([...this.accounts.values()]), ACCOUNTS_TTL_S);
  }

  private toAccount(address: string, bl: BorrowLendUserState, ch: ClearinghouseState, reserves: Map<number, PmReserve>): PmAccount {
    const borrows: PmTokenAmount[] = [];
    const supplies: PmTokenAmount[] = [];
    for (const [token, s] of bl.tokenToState) {
      const r = reserves.get(token);
      const px = r?.oraclePx ?? 0;
      const name = r?.name ?? `#${token}`;
      const b = num(s.borrow.value);
      const sup = num(s.supply.value);
      if (b > 0) borrows.push({ token, name, amount: b, usd: b * px });
      if (sup > 0) supplies.push({ token, name, amount: sup, usd: sup * px });
    }
    return {
      address,
      health: bl.health,
      healthFactor: bl.healthFactor == null ? null : Number(bl.healthFactor),
      debtUsd: borrows.reduce((s, b) => s + b.usd, 0),
      // Only tokens that count as collateral (LTV > 0); supplied stablecoins earn yield but are not collateral.
      collateralUsd: supplies.filter((s) => (reserves.get(s.token)?.ltv ?? 0) > 0).reduce((s, x) => s + x.usd, 0),
      borrows,
      supplies,
      perpAccountValue: num(ch.marginSummary.accountValue),
      perpMaintenanceMargin: num(ch.crossMaintenanceMarginUsed),
      perps: ch.assetPositions.map(({ position: p }) => ({
        coin: p.coin,
        size: num(p.szi),
        notionalUsd: num(p.positionValue),
        unrealizedPnl: num(p.unrealizedPnl),
      })),
      updatedAt: Date.now(),
    };
  }

  private async tokenNames(): Promise<Map<number, string>> {
    const meta = await cacheService.getOrSet(
      'pm:spot-tokens',
      () => info<{ tokens: { index: number; name: string }[] }>({ type: 'spotMeta' }).then((m) => m.tokens.map((t) => [t.index, t.name] as [number, string])),
      3600
    );
    return new Map(meta);
  }

  public async getReserves(): Promise<PmReserve[]> {
    return cacheService.getOrSet(
      'pm:reserves',
      async () => {
        const [states, names] = await Promise.all([
          info<[number, ReserveState][]>({ type: 'allBorrowLendReserveStates' }),
          this.tokenNames(),
        ]);
        return states.map(([token, s]) => {
          const px = num(s.oraclePx);
          const ltv = num(s.ltv);
          return {
            token,
            name: names.get(token) ?? `#${token}`,
            oraclePx: px,
            ltv,
            liquidationThreshold: ltv > 0 ? 0.5 + 0.5 * ltv : null,
            totalSupplied: num(s.totalSupplied),
            totalBorrowed: num(s.totalBorrowed),
            suppliedUsd: num(s.totalSupplied) * px,
            borrowedUsd: num(s.totalBorrowed) * px,
            utilization: num(s.utilization),
            borrowApy: num(s.borrowYearlyRate),
            supplyApy: num(s.supplyYearlyRate),
          };
        });
      },
      30
    );
  }

  public async getSnapshot(): Promise<PmSnapshot> {
    const reserves = await this.getReserves();
    const accounts = [...this.accounts.values()].filter((a) => a.updatedAt > 0).sort((a, b) => b.debtUsd - a.debtUsd || b.collateralUsd - a.collateralUsd);
    return {
      reserves,
      accounts,
      scan: { candidates: this.candidates, checked: this.scanned.size, found: this.accounts.size },
      updatedAt: Math.max(this.lastRefresh, ...accounts.map((a) => a.updatedAt), 0) || Date.now(),
    };
  }

  /** Reserve history sampled every minute by HypeDexer since 2026-09-23, resampled to `interval`. */
  public async getHistory(token: number, interval: '1h' | '4h' | '1d'): Promise<unknown> {
    return cacheService.getOrSet(
      `pm:history:${token}:${interval}`,
      () => info({ type: 'borrowLendReserveHistory', token, interval, startTime: Date.UTC(2026, 8, 23), limit: 10_000 }),
      300
    );
  }
}
