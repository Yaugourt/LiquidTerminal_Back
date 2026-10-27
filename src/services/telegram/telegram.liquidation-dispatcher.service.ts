import { prisma } from '../../core/prisma.service';
import { prismaTelegram } from '../../core/prisma.telegram.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { LiquidationsWebSocketService } from '../liquidations/liquidations.ws.service';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import { AggregatedLiquidation } from '../../types/liquidations.types';
import { formatLiquidationAlert, formatLiquidationDigestLine } from '../../utils/telegram.formatting';
import { prefetchWalletNames } from '../names/alert-wallet-names';
import { startSentAlertPurge } from '../../utils/telegram.alert-dedup';
import { AlertEngine, AlertRule } from '../alerts/alert-engine';

const CONTEXT = 'TelegramLiquidationDispatcherService';

interface LiquidationSubscriptionRow {
  id: string;
  name: string;
  telegramUserId: string;
  subscriptionType: string; // 'all' | 'filtered'
  filterCoins: string[];
  filterMinUsd: { toNumber(): number } | number;
  filterWallets: string[];
  useLinkedWallets: boolean;
  telegramUser: { telegramId: bigint; linkedUserId: number | null };
}

/**
 * Dedup id of one liquidation: the aggregator's grouping key (user, coin, direction)
 * under its transaction hash. Re-ingesting the same liquidation gives the same id,
 * while other users liquidated in the same transaction get their own.
 */
export function liquidationEventId(liq: AggregatedLiquidation): string {
  return `${liq.hash}:${liq.liquidated_user.toLowerCase()}:${liq.coin}:${liq.liq_dir}`;
}

/**
 * Compile liquidation subscriptions into engine rules. Same semantics as
 * before the engine:
 * - 'all' matches every liquidation;
 * - otherwise coins (if set), minimum USD (if set), and wallets: the user's
 *   Liquid Terminal wallets when useLinkedWallets (no wallets = no alert),
 *   else filterWallets (if set);
 * - one alert per (Telegram user, liquidation), across their subscriptions: a liquidation is
 *   the (hash, user, coin, direction) the aggregator groups on, not the hash alone, which
 *   several users share when a cascade settles in one transaction.
 * Linked wallets are resolved here, in one query, instead of per event.
 */
/** A compiled liquidation subscription; the name goes in the alert message. */
export interface LiquidationRule extends AlertRule<AggregatedLiquidation> {
  name: string;
}

export function compileLiquidationRules(
  subs: LiquidationSubscriptionRow[],
  linkedWalletsByUserId: Map<number, string[]>
): LiquidationRule[] {
  const rules: LiquidationRule[] = [];
  for (const sub of subs) {
    const telegramId = sub.telegramUser.telegramId.toString();
    const base = { id: sub.id, telegramId, dedupScope: sub.telegramUserId, name: sub.name };
    if (sub.subscriptionType === 'all') {
      rules.push({ ...base, wallets: [], coins: [], matches: () => true });
      continue;
    }
    let wallets: string[];
    if (sub.useLinkedWallets) {
      const linkedUserId = sub.telegramUser.linkedUserId;
      wallets = linkedUserId != null ? linkedWalletsByUserId.get(linkedUserId) ?? [] : [];
      if (wallets.length === 0) continue; // linked wallets required, none: never matches
    } else {
      wallets = sub.filterWallets.map((w) => w.toLowerCase());
    }
    const minUsd = Number(sub.filterMinUsd);
    rules.push({
      ...base,
      wallets,
      coins: sub.filterCoins.map((c) => c.toUpperCase()),
      matches: (liq) => !(minUsd > 0 && liq.notional_total < minUsd),
    });
  }
  return rules;
}

/**
 * TelegramLiquidationDispatcherService
 *
 * Bridges LiquidationsWebSocketService events to the Telegram bot via /ws,
 * through the shared AlertEngine (indexed matching, Redis dedup, per-user
 * budget, bounded queue). The bot receives
 * { type: 'liquidation_alert', data: { telegramId, message } }.
 */
export class TelegramLiquidationDispatcherService {
  private static instance: TelegramLiquidationDispatcherService;

  private unsubscribeCallback: (() => void) | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;

  private readonly engine = new AlertEngine<AggregatedLiquidation, LiquidationRule>({
    name: 'liquidation',
    loadRules: () => this.loadRules(),
    keys: (liq) => ({ id: liquidationEventId(liq), wallets: [liq.liquidated_user.toLowerCase()], coin: liq.coin }),
    deliver: (rule, liq) => {
      InternalWebSocketServer.getInstance().broadcastLiquidationAlert(rule.telegramId, formatLiquidationAlert(liq, rule.name));
    },
    prepare: (liqs) => prefetchWalletNames(liqs.map((l) => l.liquidated_user)),
    summarize: (_rule, liq) => formatLiquidationDigestLine(liq),
    notify: (telegramId, message) => {
      InternalWebSocketServer.getInstance().broadcastLiquidationAlert(telegramId, message);
    },
  });

  private constructor() {}

  public static getInstance(): TelegramLiquidationDispatcherService {
    if (!TelegramLiquidationDispatcherService.instance) {
      TelegramLiquidationDispatcherService.instance = new TelegramLiquidationDispatcherService();
    }
    return TelegramLiquidationDispatcherService.instance;
  }

  public start(): void {
    this.engine.start();
    this.unsubscribeCallback = LiquidationsWebSocketService.getInstance().onProcessedLiquidation((liquidations) => {
      this.engine.ingest(liquidations);
    });

    // Legacy dedup rows (dedup now lives in Redis): purge what is left.
    this.purgeTimer = startSentAlertPurge(
      (cutoff) => prismaTelegram.telegramSentAlert.deleteMany({ where: { sentAt: { lt: cutoff } } }),
      CONTEXT
    );

    logDeduplicator.info('TelegramLiquidationDispatcherService: Started');
  }

  public stop(): void {
    if (this.unsubscribeCallback) {
      this.unsubscribeCallback();
      this.unsubscribeCallback = null;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    this.engine.stop();
    logDeduplicator.info('TelegramLiquidationDispatcherService: Stopped');
  }

  private async loadRules(): Promise<LiquidationRule[]> {
    const subs = await prismaTelegram.telegramSubscription.findMany({
      where: { isActive: true },
      include: { telegramUser: { select: { telegramId: true, linkedUserId: true } } },
    });

    const linkedUserIds = [
      ...new Set(
        subs
          .filter((s) => s.useLinkedWallets && s.subscriptionType !== 'all')
          .map((s) => s.telegramUser.linkedUserId)
          .filter((id): id is number => id != null)
      ),
    ];
    const linked = new Map<number, string[]>();
    if (linkedUserIds.length) {
      const rows = await prisma.userWallet.findMany({
        where: { userId: { in: linkedUserIds } },
        select: { userId: true, Wallet: { select: { address: true } } },
      });
      for (const row of rows) {
        const list = linked.get(row.userId) ?? [];
        list.push(row.Wallet.address.toLowerCase());
        linked.set(row.userId, list);
      }
    }
    return compileLiquidationRules(subs, linked);
  }
}
