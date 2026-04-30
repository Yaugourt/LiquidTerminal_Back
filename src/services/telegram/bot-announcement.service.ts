import { prisma } from '../../core/prisma.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { InternalWebSocketServer } from '../../websocket/ws.server';
import { CURRENT_BOT_VERSION, BOT_ANNOUNCEMENT_MESSAGE } from '../../config/bot-changelog';

/**
 * On each deploy, broadcasts the current version's changelog to every Telegram user
 * who hasn't seen it yet (lastSeenBotVersion != CURRENT_BOT_VERSION).
 *
 * To announce a new update: bump CURRENT_BOT_VERSION in src/config/bot-changelog.ts.
 */
export class BotAnnouncementService {
  private static instance: BotAnnouncementService;

  private static readonly MIN_DELAY_MS = 35;

  private constructor() {}

  public static getInstance(): BotAnnouncementService {
    if (!BotAnnouncementService.instance) {
      BotAnnouncementService.instance = new BotAnnouncementService();
    }
    return BotAnnouncementService.instance;
  }

  /**
   * Called once at startup. Broadcasts to all users who haven't seen CURRENT_BOT_VERSION.
   * Idempotent: safe to call on every restart — already-notified users are skipped.
   */
  public start(): void {
    // Delay to let the bot WebSocket connect first
    setTimeout(() => {
      void this.broadcastIfNeeded();
    }, 15_000);

    logDeduplicator.info('BotAnnouncementService: Started — will broadcast if needed in 15s', {
      version: CURRENT_BOT_VERSION,
    });
  }

  public stop(): void {
    logDeduplicator.info('BotAnnouncementService: Stopped');
  }

  private async broadcastIfNeeded(): Promise<void> {
    const users = await prisma.telegramUser.findMany({
      where: {
        OR: [
          { lastSeenBotVersion: null },
          { lastSeenBotVersion: { not: CURRENT_BOT_VERSION } },
        ],
      },
      select: { telegramId: true },
    });

    if (users.length === 0) {
      logDeduplicator.info('BotAnnouncementService: All users up to date, no broadcast needed', {
        version: CURRENT_BOT_VERSION,
      });
      return;
    }

    logDeduplicator.info('BotAnnouncementService: Broadcasting changelog to users', {
      version: CURRENT_BOT_VERSION,
      count: users.length,
    });

    const wsServer = InternalWebSocketServer.getInstance();
    let delivered = 0;
    let skipped = 0;
    let lastSentAt = 0;

    for (const user of users) {
      const wait = BotAnnouncementService.MIN_DELAY_MS - (Date.now() - lastSentAt);
      if (wait > 0) await sleep(wait);

      const telegramId = user.telegramId.toString();
      const sent = wsServer.broadcastBotAnnouncement(telegramId, BOT_ANNOUNCEMENT_MESSAGE);

      if (sent > 0) {
        await prisma.telegramUser.update({
          where: { telegramId: user.telegramId },
          data: { lastSeenBotVersion: CURRENT_BOT_VERSION },
        });
        delivered++;
        lastSentAt = Date.now();
      } else {
        skipped++;
      }
    }

    logDeduplicator.info('BotAnnouncementService: Broadcast complete', {
      version: CURRENT_BOT_VERSION,
      delivered,
      skipped,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
