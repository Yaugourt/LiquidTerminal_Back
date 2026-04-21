import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../../core/prisma.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HypeDexerHip4EventsWSClient } from '../../clients/hypedexer/websocket/hip4-events.ws.client';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import type { Hip4EventPayload } from '../../types/hip4-events.types';
import {
  buildHip4EventDedupeKey,
  formatHip4TelegramMessage,
  getMatchedHip4AlertKeywords,
} from '../../utils/telegram.hip4';

/**
 * Returns true when HIP-4 → Telegram pipeline is active (default: on). Set HIP4_TELEGRAM_ENABLED=false to disable.
 */
export function isHip4TelegramEnabled(): boolean {
  const v = process.env.HIP4_TELEGRAM_ENABLED;
  if (v === undefined || v === '') return true;
  return v !== 'false' && v !== '0';
}

interface CachedTelegramUser {
  id: string;
  telegramId: string;
}

/**
 * Bridges HypeDexer `hip4_events` to all Telegram users via InternalWebSocketServer /ws.
 *
 * Dedupe flow: claim row (INSERT) → broadcast → if broadcast fails or 0 clients, DELETE row so a later retry can deliver.
 */
export class TelegramHip4DispatcherService {
  private static instance: TelegramHip4DispatcherService;

  private wsClient: HypeDexerHip4EventsWSClient | null = null;
  private unsubscribeCallback: (() => void) | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  private userCache: CachedTelegramUser[] = [];
  private cacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;
  /** Delete dedupe rows older than this (keeps table bounded). */
  private static readonly DEDUPE_RETENTION_DAYS = 90;
  private static readonly CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

  private constructor() {}

  public static getInstance(): TelegramHip4DispatcherService {
    if (!TelegramHip4DispatcherService.instance) {
      TelegramHip4DispatcherService.instance = new TelegramHip4DispatcherService();
    }
    return TelegramHip4DispatcherService.instance;
  }

  public start(): void {
    if (!isHip4TelegramEnabled()) {
      logDeduplicator.info('TelegramHip4DispatcherService: Disabled (HIP4_TELEGRAM_ENABLED=false)');
      return;
    }

    this.wsClient = HypeDexerHip4EventsWSClient.getInstance();
    this.wsClient.start();

    this.unsubscribeCallback = this.wsClient.onHip4Event((payload) => {
      void this.safeDispatch(payload);
    });

    this.cleanupInterval = setInterval(() => {
      void this.cleanupOldHip4DedupeRows();
    }, TelegramHip4DispatcherService.CLEANUP_INTERVAL_MS);
    void this.cleanupOldHip4DedupeRows();

    logDeduplicator.info('TelegramHip4DispatcherService: Started');
  }

  public stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.unsubscribeCallback) {
      this.unsubscribeCallback();
      this.unsubscribeCallback = null;
    }
    if (this.wsClient) {
      this.wsClient.stop();
      this.wsClient = null;
    }
    this.userCache = [];
    this.cacheLoadedAt = 0;

    logDeduplicator.info('TelegramHip4DispatcherService: Stopped');
  }

  /**
   * Ensures async dispatch errors never become unhandled rejections on the upstream WS callback.
   */
  private async safeDispatch(payload: Hip4EventPayload): Promise<void> {
    try {
      await this.dispatch(payload);
    } catch (error) {
      logDeduplicator.error('TelegramHip4DispatcherService: dispatch failed (unexpected)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureUserCacheFresh(): Promise<void> {
    if (Date.now() - this.cacheLoadedAt < TelegramHip4DispatcherService.CACHE_TTL_MS) return;

    try {
      const users = await prisma.telegramUser.findMany({
        select: { id: true, telegramId: true },
      });
      this.userCache = users.map((u) => ({
        id: u.id,
        telegramId: u.telegramId.toString(),
      }));
      this.cacheLoadedAt = Date.now();
      logDeduplicator.debug('TelegramHip4DispatcherService: User cache refreshed', {
        count: this.userCache.length,
      });
    } catch (error) {
      logDeduplicator.error('TelegramHip4DispatcherService: Failed to refresh user cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatch(payload: Hip4EventPayload): Promise<void> {
    const matched = getMatchedHip4AlertKeywords(payload.keywords);
    if (matched.length === 0) {
      return;
    }

    await this.ensureUserCacheFresh();
    if (this.userCache.length === 0) {
      return;
    }

    const eventDedupeKey = buildHip4EventDedupeKey(payload);
    const message = formatHip4TelegramMessage(payload, matched);

    for (const user of this.userCache) {
      const claimed = await this.tryClaimHip4DedupeSlot(user.id, eventDedupeKey);
      if (!claimed) {
        continue;
      }

      try {
        const sent = InternalWebSocketServer.getInstance().broadcastHip4EventAlert(user.telegramId, message);
        if (sent === 0) {
          await this.releaseHip4DedupeSlot(user.id, eventDedupeKey);
          logDeduplicator.warn(
            'TelegramHip4DispatcherService: No WS client for HIP-4 alert — dedupe row released for retry',
            {
              telegramId: user.telegramId,
              telegramUserId: user.id,
              eventDedupeKey: eventDedupeKey.slice(0, 12),
            }
          );
          continue;
        }

        logDeduplicator.info('TelegramHip4DispatcherService: HIP-4 alert dispatched', {
          telegramId: user.telegramId,
          eventDedupeKey: eventDedupeKey.slice(0, 12),
          keywords: matched,
          wsClients: sent,
        });
      } catch (error) {
        await this.releaseHip4DedupeSlot(user.id, eventDedupeKey);
        logDeduplicator.error('TelegramHip4DispatcherService: Failed to broadcast — dedupe row released', {
          error: error instanceof Error ? error.message : String(error),
          telegramUserId: user.id,
          eventDedupeKey: eventDedupeKey.slice(0, 12),
        });
      }
    }
  }

  /**
   * INSERT dedupe row. Returns true if this worker claimed the slot (new row), false if duplicate.
   */
  private async tryClaimHip4DedupeSlot(telegramUserId: string, eventDedupeKey: string): Promise<boolean> {
    const inserted = await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "telegram_hip4_sent_alerts" ("id", "telegram_user_id", "event_dedupe_key")
      VALUES (${randomUUID()}, ${telegramUserId}, ${eventDedupeKey})
      ON CONFLICT ("telegram_user_id", "event_dedupe_key") DO NOTHING
    `);
    const n = typeof inserted === 'bigint' ? Number(inserted) : Number(inserted);
    return n > 0;
  }

  /**
   * Remove dedupe row so a failed or skipped delivery can be retried on a future event pass.
   */
  private async releaseHip4DedupeSlot(telegramUserId: string, eventDedupeKey: string): Promise<void> {
    try {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "telegram_hip4_sent_alerts"
        WHERE "telegram_user_id" = ${telegramUserId} AND "event_dedupe_key" = ${eventDedupeKey}
      `);
    } catch (error) {
      logDeduplicator.error('TelegramHip4DispatcherService: releaseHip4DedupeSlot failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async cleanupOldHip4DedupeRows(): Promise<void> {
    try {
      const days = TelegramHip4DispatcherService.DEDUPE_RETENTION_DAYS;
      const result = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "telegram_hip4_sent_alerts"
        WHERE "sent_at" < NOW() - (INTERVAL '1 day' * ${days})
      `);
      const n = typeof result === 'bigint' ? Number(result) : Number(result);
      if (n > 0) {
        logDeduplicator.info('TelegramHip4DispatcherService: Old HIP-4 dedupe rows deleted', {
          deleted: n,
          olderThanDays: days,
        });
      }
    } catch (error) {
      logDeduplicator.error('TelegramHip4DispatcherService: cleanupOldHip4DedupeRows failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
