import { prisma } from '../../core/prisma.service';
import { prismaTelegram } from '../../core/prisma.telegram.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import { HyperliquidPerpClient } from '../../clients/hyperliquid/perp/perp.assetcontext.client';
import { LiquidationsWebSocketService } from '../liquidations/liquidations.ws.service';
import { AggregatedLiquidation } from '../../types/liquidations.types';
import { escapeHtml } from '../../utils/telegram.formatting';
import { renderAlertMessage, SITE } from '../../utils/alert-message';
import { AlertEngine, AlertRule } from './alert-engine';
import { AlertRuleParams, AlertRuleType } from './alert-rule.types';
import {
  LedgerUpdate,
  RY_ASSISTANCE_FUND,
  RY_INTEREST_ADDRESS,
  RY_MIN_USDC,
} from '../revenue/reserve-yield.ledger';
import { readReserveLedger } from '../revenue/reserve-yield.source';

/**
 * Market alerts: price, funding, open interest, listings, leverage changes and
 * liquidation cascades, from rules in the generic AlertRule table.
 *
 * Sources already running in the backend: the perp snapshot that
 * HyperliquidPerpClient refreshes every 10s (read from its cache, no extra
 * upstream calls) and the processed liquidation stream. The trackers below
 * turn them into events; the shared AlertEngine matches, dedups, budgets and
 * delivers them on the generic `alert` channel.
 */

// ============================================================================
// EVENTS
// ============================================================================

export type MarketEvent =
  | {
      kind: 'tick';
      id: string;
      coin: string;
      ts: number;
      px: number;
      prevPx: number | null;
      change1hPct: number | null;
      change24hPct: number | null;
      fundingAprPct: number;
      oiUsd: number;
      oiChange1hPct: number | null;
    }
  | { kind: 'listing'; id: string; coin: string; ts: number; maxLeverage: number; px: number }
  | { kind: 'leverage'; id: string; coin: string; ts: number; from: number; to: number }
  | { kind: 'cascade'; id: string; coin: string; ts: number; usd60s: number; count60s: number; scope: 'coin' | 'market' }
  | {
      kind: 'reserve_yield';
      id: string;
      coin: string;
      ts: number;
      /** `paid`: reached the interest address; `to_fund`: sent on to the Assistance Fund. */
      stage: 'paid' | 'to_fund';
      amount: number;
      from: string;
      hash: string;
    };

/** Market-wide events carry this coin; coin-specific rules never match it. */
export const MARKET_WIDE = '*';

const HOUR = 3_600_000;

export interface PerpRow {
  name: string;
  maxLeverage: number;
  isDelisted?: boolean;
  markPx: number;
  prevDayPx: number;
  funding: number;
  openInterest: number;
}

/**
 * Turns successive perp snapshots into events. Keeps one hour of (ts, px,
 * oiUsd) samples per coin for the 1h changes; 24h change uses prevDayPx.
 * Listing detection compares coin sets; the first snapshot only seeds them.
 */
export class MarketSnapshotTracker {
  private readonly history = new Map<string, { ts: number; px: number; oiUsd: number }[]>();
  private readonly lastPx = new Map<string, number>();
  private readonly lastLeverage = new Map<string, number>();
  private knownCoins: Set<string> | null = null;

  constructor(knownCoins?: Iterable<string>) {
    if (knownCoins) this.knownCoins = new Set(knownCoins);
  }

  get coins(): string[] {
    return [...(this.knownCoins ?? [])];
  }

  update(rows: PerpRow[], ts: number): MarketEvent[] {
    const events: MarketEvent[] = [];
    const seeding = this.knownCoins === null;
    const known = this.knownCoins ?? new Set<string>();

    for (const r of rows) {
      if (r.isDelisted || !(r.markPx > 0)) continue;
      const coin = r.name;
      const oiUsd = r.openInterest * r.markPx;

      if (!seeding && !known.has(coin)) {
        events.push({ kind: 'listing', id: `listing:${coin}`, coin, ts, maxLeverage: r.maxLeverage, px: r.markPx });
      }
      known.add(coin);

      const prevLev = this.lastLeverage.get(coin);
      if (prevLev !== undefined && prevLev !== r.maxLeverage) {
        events.push({ kind: 'leverage', id: `leverage:${coin}:${ts}`, coin, ts, from: prevLev, to: r.maxLeverage });
      }
      this.lastLeverage.set(coin, r.maxLeverage);

      const samples = this.history.get(coin) ?? [];
      samples.push({ ts, px: r.markPx, oiUsd });
      while (samples.length && samples[0].ts < ts - HOUR) samples.shift();
      this.history.set(coin, samples);
      // A 1h change needs close to an hour of history (restarts begin empty).
      const base = samples[0];
      const hasHour = base && ts - base.ts >= 55 * 60_000;

      events.push({
        kind: 'tick',
        id: `tick:${coin}:${ts}`,
        coin,
        ts,
        px: r.markPx,
        prevPx: this.lastPx.get(coin) ?? null,
        change1hPct: hasHour ? ((r.markPx - base.px) / base.px) * 100 : null,
        change24hPct: r.prevDayPx > 0 ? ((r.markPx - r.prevDayPx) / r.prevDayPx) * 100 : null,
        fundingAprPct: r.funding * 24 * 365 * 100,
        oiUsd,
        oiChange1hPct: hasHour && base.oiUsd > 0 ? ((oiUsd - base.oiUsd) / base.oiUsd) * 100 : null,
      });
      this.lastPx.set(coin, r.markPx);
    }
    this.knownCoins = known;
    return events;
  }
}

/** Rolling 60s liquidation totals per coin and market-wide. */
export class CascadeTracker {
  private readonly windows = new Map<string, { ts: number; usd: number }[]>();

  constructor(private readonly windowMs = 60_000) {}

  add(liq: AggregatedLiquidation, now: number): MarketEvent[] {
    const out: MarketEvent[] = [];
    for (const [coin, scope] of [
      [liq.coin.toUpperCase(), 'coin'],
      [MARKET_WIDE, 'market'],
    ] as const) {
      const w = this.windows.get(coin) ?? [];
      w.push({ ts: now, usd: liq.notional_total });
      while (w.length && w[0].ts < now - this.windowMs) w.shift();
      this.windows.set(coin, w);
      out.push({
        kind: 'cascade',
        id: `cascade:${coin}:${liq.hash}`,
        coin,
        ts: now,
        usd60s: w.reduce((s, x) => s + x.usd, 0),
        count60s: w.length,
        scope,
      });
    }
    return out;
  }
}

// ============================================================================
// RESERVE YIELD
// ============================================================================

export { RY_INTEREST_ADDRESS, RY_ASSISTANCE_FUND, RY_MIN_USDC };
export type { LedgerUpdate };

/**
 * Reads the interest address ledger into reserve yield events: USDC arriving
 * from outside is a payment, USDC leaving for the Assistance Fund is the
 * forward. System sends carry a zero hash, so ids include the time.
 */
export function reserveYieldEvents(updates: LedgerUpdate[], after: number): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const u of updates) {
    if (u.time <= after || u.delta.type !== 'send' || u.delta.token !== 'USDC') continue;
    const from = (u.delta.user ?? '').toLowerCase();
    const to = (u.delta.destination ?? '').toLowerCase();
    const amount = Number(u.delta.amount ?? 0);
    if (!(amount >= RY_MIN_USDC)) continue;
    let stage: 'paid' | 'to_fund' | null = null;
    if (to === RY_INTEREST_ADDRESS && from !== RY_INTEREST_ADDRESS) stage = 'paid';
    else if (from === RY_INTEREST_ADDRESS && to === RY_ASSISTANCE_FUND) stage = 'to_fund';
    if (!stage) continue;
    out.push({ kind: 'reserve_yield', id: `ry:${stage}:${u.hash}:${u.time}`, coin: 'USDC', ts: u.time, stage, amount, from, hash: u.hash });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ============================================================================
// RULES
// ============================================================================

export interface MarketRuleRow {
  id: string;
  telegramId: string;
  type: AlertRuleType;
  name: string;
  params: AlertRuleParams[AlertRuleType];
}

export interface MarketRule extends AlertRule<MarketEvent> {
  type: AlertRuleType;
  name: string;
  params: Record<string, unknown>;
}

/** Minimum time between two alerts of one rule on one coin. */
export const RULE_COOLDOWN_MS: Partial<Record<AlertRuleType, number>> = {
  price_cross: 15 * 60_000,
  funding: 8 * HOUR,
  oi_surge: HOUR,
  liq_cascade: 10 * 60_000,
};

/**
 * Compile stored rules into engine rules. `cooldowns` outlives each compile
 * (rules are recompiled every 30s) so a rule doesn't re-fire after a refresh.
 */
export function compileMarketRules(rows: MarketRuleRow[], cooldowns: Map<string, number>): MarketRule[] {
  const cooled = (rule: MarketRuleRow, coin: string, ts: number, ms: number) => {
    const key = `${rule.id}:${coin}`;
    const last = cooldowns.get(key);
    if (last !== undefined && ts - last < ms) return false;
    cooldowns.set(key, ts);
    return true;
  };

  return rows.map((row) => {
    const p = row.params as Record<string, unknown>;
    const coin = (p.coin as string | null | undefined) ?? null;
    const base = { id: row.id, telegramId: row.telegramId, dedupScope: row.id, type: row.type, name: row.name, params: p, wallets: [] };
    const coins = coin ? [coin] : [];
    let test: (e: MarketEvent) => boolean;

    switch (row.type) {
      case 'price_cross': {
        const level = p.level as number;
        const above = p.direction === 'above';
        test = (e) =>
          e.kind === 'tick' &&
          e.prevPx !== null &&
          (above ? e.prevPx < level && e.px >= level : e.prevPx > level && e.px <= level) &&
          cooled(row, e.coin, e.ts, RULE_COOLDOWN_MS.price_cross as number);
        break;
      }
      case 'price_move': {
        const threshold = p.pct as number;
        const window = p.window as '1h' | '24h';
        const dir = p.direction as 'up' | 'down' | 'both';
        test = (e) => {
          if (e.kind !== 'tick') return false;
          const ch = window === '1h' ? e.change1hPct : e.change24hPct;
          if (ch === null) return false;
          const hit = dir === 'up' ? ch >= threshold : dir === 'down' ? ch <= -threshold : Math.abs(ch) >= threshold;
          return hit && cooled(row, e.coin, e.ts, window === '1h' ? HOUR : 24 * HOUR);
        };
        break;
      }
      case 'funding': {
        const apr = p.aprPct as number;
        test = (e) => e.kind === 'tick' && Math.abs(e.fundingAprPct) >= apr && cooled(row, e.coin, e.ts, RULE_COOLDOWN_MS.funding as number);
        break;
      }
      case 'oi_surge': {
        const threshold = p.pct as number;
        const minOi = p.minOiUsd as number;
        test = (e) =>
          e.kind === 'tick' &&
          e.oiChange1hPct !== null &&
          e.oiChange1hPct >= threshold &&
          e.oiUsd >= minOi &&
          cooled(row, e.coin, e.ts, RULE_COOLDOWN_MS.oi_surge as number);
        break;
      }
      case 'listing':
        test = (e) => e.kind === 'listing';
        break;
      case 'leverage':
        test = (e) => e.kind === 'leverage';
        break;
      case 'liq_cascade': {
        const min = p.minUsd as number;
        // No coin = market-wide totals only; a coin = that coin's totals only.
        const scope = coin ? 'coin' : 'market';
        test = (e) =>
          e.kind === 'cascade' &&
          e.scope === scope &&
          e.usd60s >= min &&
          cooled(row, e.coin, e.ts, RULE_COOLDOWN_MS.liq_cascade as number);
        break;
      }
      case 'reserve_yield':
        test = (e) => e.kind === 'reserve_yield';
        break;
      default:
        test = () => false;
    }
    // Market-wide cascade rules must still reach the '*' events through the index.
    const indexCoins = row.type === 'liq_cascade' && !coin ? [MARKET_WIDE] : coins;
    return { ...base, coins: indexCoins, matches: test };
  });
}

// ============================================================================
// MESSAGES
// ============================================================================

const money = (v: number) =>
  Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(2)}`;
const price = (v: number) => `$${v.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const coinName = (coin: string) => (coin === MARKET_WIDE ? 'All markets' : escapeHtml(coin));
const marketLink = (coin: string) =>
  coin === MARKET_WIDE
    ? { label: 'Perp markets', url: `${SITE}/market/perp` }
    : { label: `${coin} market`, url: `${SITE}/market/perp/${encodeURIComponent(coin)}` };

/** Market alerts share the alert message shape of fills and liquidations (utils/alert-message). */
export function formatMarketAlert(rule: MarketRule, e: MarketEvent): string {
  switch (e.kind) {
    case 'tick': {
      const ch24 = e.change24hPct !== null ? `${signed(e.change24hPct)} in 24h` : null;
      if (rule.type === 'price_cross') {
        const up = rule.params.direction === 'above';
        return renderAlertMessage({
          icon: '🎯',
          headline: `${coinName(e.coin)} ${up ? 'above' : 'below'} ${price(rule.params.level as number)}`,
          alertName: rule.name,
          lines: [`💵 Now ${price(e.px)}${ch24 ? ` · ${ch24}` : ''}`],
          links: [marketLink(e.coin)],
        });
      }
      if (rule.type === 'funding') {
        return renderAlertMessage({
          icon: '💸',
          headline: `${coinName(e.coin)} funding ${e.fundingAprPct.toFixed(1)}% a year`,
          alertName: rule.name,
          lines: [
            e.fundingAprPct >= 0 ? '🟢 Longs pay shorts' : '🔴 Shorts pay longs',
            `💵 ${price(e.px)} · open interest ${money(e.oiUsd)}`,
          ],
          links: [marketLink(e.coin)],
        });
      }
      if (rule.type === 'oi_surge') {
        return renderAlertMessage({
          icon: '📊',
          headline: `${coinName(e.coin)} open interest ${signed(e.oiChange1hPct ?? 0)} in 1h`,
          alertName: rule.name,
          lines: [`📊 Now ${money(e.oiUsd)}`, `💵 ${price(e.px)}${ch24 ? ` · ${ch24}` : ''}`],
          links: [marketLink(e.coin)],
        });
      }
      const window = rule.params.window === '1h' ? '1h' : '24h';
      const ch = window === '1h' ? e.change1hPct : e.change24hPct;
      return renderAlertMessage({
        icon: (ch ?? 0) >= 0 ? '📈' : '📉',
        headline: `${coinName(e.coin)} ${signed(ch ?? 0)} in ${window}`,
        alertName: rule.name,
        lines: [
          `💵 Now ${price(e.px)}`,
          window === '1h' && e.change24hPct !== null ? `📅 ${signed(e.change24hPct)} in 24h` : null,
        ],
        links: [marketLink(e.coin)],
      });
    }
    case 'listing':
      return renderAlertMessage({
        icon: '🆕',
        headline: `${coinName(e.coin)} perp is live`,
        alertName: rule.name,
        lines: [`⚙️ Up to ${e.maxLeverage}x leverage`, `💵 Mark ${price(e.px)}`],
        links: [marketLink(e.coin)],
      });
    case 'leverage':
      return renderAlertMessage({
        icon: '⚙️',
        headline: `${coinName(e.coin)} max leverage ${e.from}x → ${e.to}x`,
        alertName: rule.name,
        lines: [e.to < e.from ? '🔻 Leverage cut: positions above the new cap may need more margin' : '🔺 Leverage raised'],
        links: [marketLink(e.coin)],
      });
    case 'cascade':
      return renderAlertMessage({
        icon: '🚨',
        headline: `${coinName(e.coin)}: ${money(e.usd60s)} liquidated in 60s`,
        alertName: rule.name,
        lines: [`🧩 ${e.count60s} liquidation${e.count60s > 1 ? 's' : ''} in the last minute`],
        links: [{ label: 'Liquidations feed', url: `${SITE}/explorer/liquidations` }, marketLink(e.coin)],
      });
    case 'reserve_yield': {
      const amount = `${e.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
      const tx = /^0x0+$/.test(e.hash) ? [] : [{ label: 'Transaction', url: `${SITE}/explorer/transaction/${e.hash}` }];
      return renderAlertMessage({
        icon: e.stage === 'paid' ? '💵' : '🔥',
        headline: e.stage === 'paid' ? `Reserve yield paid to Hyperliquid · ${money(e.amount)}` : `Reserve yield sent to the Assistance Fund · ${money(e.amount)}`,
        alertName: rule.name,
        lines:
          e.stage === 'paid'
            ? [`💵 ${amount} reached the protocol's interest address`, '➡️ Next: it goes to the Assistance Fund, which buys HYPE with it']
            : [`🔥 ${amount} now with the Assistance Fund, for HYPE buybacks`],
        links: [...tx, { label: 'Reserve yield', url: `${SITE}/hype/reserve-yield` }],
      });
    }
  }
}

export function summarizeMarketAlert(rule: MarketRule, e: MarketEvent): string {
  switch (e.kind) {
    case 'tick':
      return `🔔 ${escapeHtml(e.coin)} ${price(e.px)} · <i>${escapeHtml(rule.name)}</i>`;
    case 'listing':
      return `🆕 ${escapeHtml(e.coin)} listed (${e.maxLeverage}x)`;
    case 'leverage':
      return `⚙️ ${escapeHtml(e.coin)} max leverage ${e.from}x → ${e.to}x`;
    case 'cascade':
      return `🚨 ${e.coin === MARKET_WIDE ? 'All markets' : escapeHtml(e.coin)} ${money(e.usd60s)} liquidated in 60s`;
    case 'reserve_yield':
      return e.stage === 'paid' ? `💵 Reserve yield paid: ${money(e.amount)}` : `🔥 Reserve yield to the fund: ${money(e.amount)}`;
  }
}

// ============================================================================
// SERVICE
// ============================================================================

const MARKET_TYPES: AlertRuleType[] = [
  'price_cross',
  'price_move',
  'funding',
  'oi_surge',
  'listing',
  'leverage',
  'liq_cascade',
  'reserve_yield',
];
const KNOWN_COINS_KEY = 'alerts:market:known_perps';
const POLL_MS = 10_000;
/** Payments land once a month; one ledger read a minute is plenty. */
const RY_POLL_MS = 60_000;
/** Time of the last ledger entry turned into events, so a restart neither replays nor skips. */
const RY_CURSOR_KEY = 'alerts:market:reserve_yield_cursor';
/**
 * Each read starts this long before the cursor, so a row the indexer commits
 * late (out of time order) still alerts. The rows read twice are absorbed by the
 * engine's per-event dedup (`alert:market:<rule>:<event id>`, claimed in Redis
 * for 24 h, and the in-memory recent-event cache): the id holds the stage, hash
 * and time, so it is the same on every read.
 */
const RY_OVERLAP_MS = 60_000;

/**
 * Feeds market events into an AlertEngine. Rules come from AlertRule and are
 * only active while their Telegram account is still linked to the owner.
 */
export class MarketAlertsService {
  private static instance: MarketAlertsService;
  private readonly cooldowns = new Map<string, number>();
  private tracker: MarketSnapshotTracker | null = null;
  private readonly cascades = new CascadeTracker();
  private timer: NodeJS.Timeout | null = null;
  private ryTimer: NodeJS.Timeout | null = null;
  private unsubscribeLiq: (() => void) | null = null;

  private readonly engine = new AlertEngine<MarketEvent, MarketRule>({
    name: 'market',
    loadRules: () => this.loadRules(),
    keys: (e) => ({ id: e.id, wallets: [], coin: e.coin }),
    deliver: (rule, e) => {
      InternalWebSocketServer.getInstance().broadcastAlert(rule.telegramId, formatMarketAlert(rule, e), rule.type);
    },
    summarize: summarizeMarketAlert,
    notify: (telegramId, message) => {
      InternalWebSocketServer.getInstance().broadcastAlert(telegramId, message, 'digest');
    },
  });

  public static getInstance(): MarketAlertsService {
    if (!MarketAlertsService.instance) MarketAlertsService.instance = new MarketAlertsService();
    return MarketAlertsService.instance;
  }

  public start(): void {
    this.engine.start();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    this.ryTimer = setInterval(() => void this.pollReserveYield(), RY_POLL_MS);
    this.ryTimer.unref?.();
    this.unsubscribeLiq = LiquidationsWebSocketService.getInstance().onProcessedLiquidation((liqs) => {
      const now = Date.now();
      this.engine.ingest(liqs.flatMap((l) => this.cascades.add(l, now)));
    });
    logDeduplicator.info('MarketAlertsService: Started');
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ryTimer) clearInterval(this.ryTimer);
    this.ryTimer = null;
    this.unsubscribeLiq?.();
    this.unsubscribeLiq = null;
    this.engine.stop();
  }

  private async poll(): Promise<void> {
    try {
      if (!this.tracker) {
        const stored = await redisService.get(KNOWN_COINS_KEY);
        this.tracker = new MarketSnapshotTracker(stored ? (JSON.parse(stored) as string[]) : undefined);
      }
      const [meta, ctxs] = await HyperliquidPerpClient.getInstance().getMetaAndAssetCtxsRaw();
      const rows: PerpRow[] = meta.universe.map((m, i) => ({
        name: m.name,
        maxLeverage: m.maxLeverage,
        isDelisted: (m as { isDelisted?: boolean }).isDelisted,
        markPx: Number(ctxs[i]?.markPx),
        prevDayPx: Number(ctxs[i]?.prevDayPx),
        funding: Number(ctxs[i]?.funding),
        openInterest: Number(ctxs[i]?.openInterest),
      }));
      const before = this.tracker.coins.length;
      const events = this.tracker.update(rows, Date.now());
      if (this.tracker.coins.length !== before) {
        await redisService.set(KNOWN_COINS_KEY, JSON.stringify(this.tracker.coins));
      }
      this.engine.ingest(events);
    } catch (error) {
      logDeduplicator.warn('MarketAlertsService: snapshot unavailable, skipping this tick', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async pollReserveYield(): Promise<void> {
    try {
      const stored = await redisService.get(RY_CURSOR_KEY);
      // First run: start from now rather than alerting on past payments.
      if (!stored) {
        await redisService.set(RY_CURSOR_KEY, String(Date.now()));
        return;
      }
      const cursor = Number(stored);
      // Oldest first whichever source answers (HypeDexer's /info, else Hyperliquid).
      const readFrom = Math.max(0, cursor - RY_OVERLAP_MS);
      const updates = await readReserveLedger(readFrom);
      const latest = updates.reduce((m, u) => Math.max(m, u.time), cursor);
      const events = reserveYieldEvents(updates, readFrom);
      if (events.length) this.engine.ingest(events);
      if (latest > cursor) await redisService.set(RY_CURSOR_KEY, String(latest));
    } catch (error) {
      logDeduplicator.warn('MarketAlertsService: reserve yield ledger unavailable, skipping this tick', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async loadRules(): Promise<MarketRule[]> {
    const rows = await prisma.alertRule.findMany({
      where: { isActive: true, type: { in: MARKET_TYPES } },
      select: { id: true, userId: true, telegramId: true, type: true, name: true, params: true },
    });
    if (!rows.length) return [];
    // Only rules whose Telegram account is still linked to their owner.
    const links = await prismaTelegram.telegramUser.findMany({
      where: { telegramId: { in: [...new Set(rows.map((r) => r.telegramId))] } },
      select: { telegramId: true, linkedUserId: true },
    });
    const owner = new Map(links.map((l) => [l.telegramId.toString(), l.linkedUserId]));
    const live = rows
      .filter((r) => owner.get(r.telegramId.toString()) === r.userId)
      .map((r) => ({
        id: r.id,
        telegramId: r.telegramId.toString(),
        type: r.type as AlertRuleType,
        name: r.name,
        params: r.params as AlertRuleParams[AlertRuleType],
      }));
    return compileMarketRules(live, this.cooldowns);
  }
}
