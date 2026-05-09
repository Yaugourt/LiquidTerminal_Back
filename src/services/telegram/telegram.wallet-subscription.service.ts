import { WalletEventType } from '../../types/prisma-enums';
import { prisma } from '../../core/prisma.service';
import { prismaTelegram } from '../../core/prisma.telegram.service';
import {
  TelegramUserNotFoundError,
  WalletSubscriptionNotFoundError,
  WalletSubscriptionLimitError,
} from '../../errors/telegram.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const MAX_SUBSCRIPTIONS_PER_USER = 10;

export interface CreateWalletSubscriptionInput {
  telegramId: bigint;
  name: string;
  walletAddresses?: string[];
  useLinkedWallets?: boolean;
  eventTypes?: WalletEventType[];
  minAmountUsd?: number;
}

export interface UpdateWalletSubscriptionInput {
  telegramId: bigint;
  subscriptionId: string;
  name?: string;
  walletAddresses?: string[];
  useLinkedWallets?: boolean;
  eventTypes?: WalletEventType[];
  minAmountUsd?: number;
  isActive?: boolean;
}

// Shape returned by findMany select — typed explicitly to avoid strict-mode implicit any
interface SubscriptionRow {
  id: string;
  name: string;
  isActive: boolean;
  walletAddresses: string[];
  useLinkedWallets: boolean;
  eventTypes: WalletEventType[];
  minAmountUsd: { toNumber(): number } | number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Service for managing Telegram wallet tracking subscriptions.
 * Handles CRUD for TelegramWalletSubscription records.
 * The dispatcher (bot-side) consumes these subscriptions to route wallet events.
 */
export class TelegramWalletSubscriptionService {
  private static instance: TelegramWalletSubscriptionService;

  private constructor() {}

  public static getInstance(): TelegramWalletSubscriptionService {
    if (!TelegramWalletSubscriptionService.instance) {
      TelegramWalletSubscriptionService.instance = new TelegramWalletSubscriptionService();
    }
    return TelegramWalletSubscriptionService.instance;
  }

  /** Resolve TelegramUser.id (cuid) from telegramId (BigInt), throws if not found. */
  private async resolveTelegramUserId(telegramId: bigint): Promise<string> {
    const user = await prismaTelegram.telegramUser.findUnique({
      where: { telegramId },
      select: { id: true },
    });
    if (!user) throw new TelegramUserNotFoundError();
    return user.id;
  }

  /**
   * List all wallet subscriptions for a given telegram user.
   */
  async list(telegramId: bigint) {
    const telegramUserId = await this.resolveTelegramUserId(telegramId);

    const subscriptions: SubscriptionRow[] = await prismaTelegram.telegramWalletSubscription.findMany({
      where: { telegramUserId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        isActive: true,
        walletAddresses: true,
        useLinkedWallets: true,
        eventTypes: true,
        minAmountUsd: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    logDeduplicator.info('Listed wallet subscriptions', {
      telegramId: telegramId.toString(),
      count: subscriptions.length,
    });

    return subscriptions.map((s: SubscriptionRow) => ({
      ...s,
      minAmountUsd: Number(s.minAmountUsd),
    }));
  }

  /**
   * Create a new wallet subscription.
   * Enforces a maximum of MAX_SUBSCRIPTIONS_PER_USER per user.
   */
  async create(input: CreateWalletSubscriptionInput) {
    const telegramUserId = await this.resolveTelegramUserId(input.telegramId);

    const existingCount = await prismaTelegram.telegramWalletSubscription.count({
      where: { telegramUserId },
    });
    if (existingCount >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new WalletSubscriptionLimitError();
    }

    const subscription = await prismaTelegram.telegramWalletSubscription.create({
      data: {
        telegramUserId,
        name: input.name,
        walletAddresses: input.walletAddresses ?? [],
        useLinkedWallets: input.useLinkedWallets ?? false,
        eventTypes: input.eventTypes ?? [],
        minAmountUsd: input.minAmountUsd ?? 0,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        walletAddresses: true,
        useLinkedWallets: true,
        eventTypes: true,
        minAmountUsd: true,
        createdAt: true,
      },
    });

    logDeduplicator.info('Created wallet subscription', {
      telegramId: input.telegramId.toString(),
      subscriptionId: subscription.id,
      name: subscription.name,
    });

    return { ...subscription, minAmountUsd: Number(subscription.minAmountUsd) };
  }

  /**
   * Update an existing wallet subscription.
   * Verifies ownership before updating.
   */
  async update(input: UpdateWalletSubscriptionInput) {
    const telegramUserId = await this.resolveTelegramUserId(input.telegramId);

    const existing = await prismaTelegram.telegramWalletSubscription.findUnique({
      where: { id: input.subscriptionId },
      select: { telegramUserId: true },
    });

    if (!existing) throw new WalletSubscriptionNotFoundError();
    if (existing.telegramUserId !== telegramUserId) throw new WalletSubscriptionNotFoundError();

    const updated = await prismaTelegram.telegramWalletSubscription.update({
      where: { id: input.subscriptionId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.walletAddresses !== undefined && { walletAddresses: input.walletAddresses }),
        ...(input.useLinkedWallets !== undefined && { useLinkedWallets: input.useLinkedWallets }),
        ...(input.eventTypes !== undefined && { eventTypes: input.eventTypes }),
        ...(input.minAmountUsd !== undefined && { minAmountUsd: input.minAmountUsd }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        walletAddresses: true,
        useLinkedWallets: true,
        eventTypes: true,
        minAmountUsd: true,
        updatedAt: true,
      },
    });

    logDeduplicator.info('Updated wallet subscription', {
      telegramId: input.telegramId.toString(),
      subscriptionId: updated.id,
    });

    return { ...updated, minAmountUsd: Number(updated.minAmountUsd) };
  }

  /**
   * Delete a wallet subscription and its associated sent alerts.
   * Verifies ownership before deleting.
   */
  async delete(telegramId: bigint, subscriptionId: string): Promise<void> {
    const telegramUserId = await this.resolveTelegramUserId(telegramId);

    const existing = await prismaTelegram.telegramWalletSubscription.findUnique({
      where: { id: subscriptionId },
      select: { telegramUserId: true },
    });

    if (!existing) throw new WalletSubscriptionNotFoundError();
    if (existing.telegramUserId !== telegramUserId) throw new WalletSubscriptionNotFoundError();

    await prismaTelegram.telegramWalletSubscription.delete({
      where: { id: subscriptionId },
    });

    logDeduplicator.info('Deleted wallet subscription', {
      telegramId: telegramId.toString(),
      subscriptionId,
    });
  }

  /**
   * Get all active wallet subscriptions (used by the bot dispatcher).
   * Returns subscriptions with their resolved wallet addresses,
   * including linked wallets from the user's LT account if useLinkedWallets is true.
   */
  async getActiveSubscriptions() {
    const subscriptions = await prismaTelegram.telegramWalletSubscription.findMany({
      where: { isActive: true },
      include: {
        telegramUser: {
          select: {
            telegramId: true,
            linkedUserId: true,
          },
        },
      },
    });

    // Cross-DB lookup: fetch UserWallets for all linked users from Core DB.
    const linkedUserIds = Array.from(
      new Set(
        subscriptions
          .map((sub) => sub.telegramUser.linkedUserId)
          .filter((id): id is number => id !== null && id !== undefined)
      )
    );

    const userWalletsByUserId = new Map<number, { Wallet: { address: string } }[]>();

    if (linkedUserIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: linkedUserIds } },
        select: {
          id: true,
          UserWallets: {
            include: { Wallet: { select: { address: true } } },
          },
        },
      });

      for (const u of users) {
        userWalletsByUserId.set(u.id, u.UserWallets);
      }
    }

    return subscriptions.map((sub) => {
      const linkedUserId = sub.telegramUser.linkedUserId;
      const userWallets =
        linkedUserId !== null && linkedUserId !== undefined
          ? (userWalletsByUserId.get(linkedUserId) ?? [])
          : [];

      const linkedAddresses = sub.useLinkedWallets
        ? userWallets.map(
            (uw: { Wallet: { address: string } }) => uw.Wallet.address
          )
        : [];

      const allAddresses = [...new Set([...sub.walletAddresses, ...linkedAddresses])];

      return {
        id: sub.id,
        telegramId: sub.telegramUser.telegramId.toString(),
        name: sub.name,
        walletAddresses: allAddresses,
        eventTypes: sub.eventTypes,
        minAmountUsd: Number(sub.minAmountUsd),
      };
    });
  }
}
