/**
 * runPoll is started with `void` from timers: a rejection escaping it reaches the
 * process-level unhandledRejection handler and restarts the whole back. One bad
 * page must be skipped, not the poll, and a failing final write must be logged.
 */
const mockDb = {
  findMany: jest.fn(),
  upsert: jest.fn(),
  updateMany: jest.fn(),
  broadcast: jest.fn(() => 1),
};

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../src/core/prisma.content.service', () => ({
  prismaContent: {
    hyperliquidDocPage: {
      findMany: (...a: unknown[]) => mockDb.findMany(...a),
      upsert: (...a: unknown[]) => mockDb.upsert(...a),
      updateMany: (...a: unknown[]) => mockDb.updateMany(...a),
    },
  },
}));

jest.mock('../../../src/core/prisma.telegram.service', () => ({
  prismaTelegram: {
    telegramUser: { findMany: jest.fn(async () => [{ id: 'u1', telegramId: BigInt(1) }]) },
  },
}));

jest.mock('../../../src/websocket/ws.server', () => ({
  InternalWebSocketServer: {
    getInstance: () => ({ broadcastDocUpdateAlert: (...a: unknown[]) => (mockDb.broadcast as (...x: unknown[]) => number)(...a) }),
  },
}));

import { logDeduplicator } from '../../../src/utils/logDeduplicator';
import { TelegramDocUpdateDispatcherService } from '../../../src/services/telegram/telegram.doc-update-dispatcher.service';

const SITEMAP = `<urlset>
<url><loc>not a url</loc></url>
<url><loc>https://hyperliquid.gitbook.io/hyperliquid-docs/a</loc></url>
<url><loc>https://hyperliquid.gitbook.io/hyperliquid-docs/b</loc></url>
</urlset>`;

function mockFetch(): void {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => (url.endsWith('sitemap.xml') ? SITEMAP : `new content of ${url}`),
  }));
}

async function poll(): Promise<void> {
  const svc = TelegramDocUpdateDispatcherService.getInstance() as unknown as { runPoll(): Promise<void> };
  const done = svc.runPoll();
  await jest.advanceTimersByTimeAsync(5_000);
  await done;
}

describe('TelegramDocUpdateDispatcherService.runPoll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockFetch();
    mockDb.broadcast.mockReturnValue(1);
    mockDb.updateMany.mockResolvedValue({ count: 1 });
    mockDb.upsert.mockResolvedValue({});
    mockDb.findMany.mockResolvedValue([
      { pageUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/a', contentHash: 'old', content: 'old' },
      { pageUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/b', contentHash: 'old', content: 'old' },
    ]);
  });

  afterEach(() => jest.useRealTimers());

  it('skips a malformed URL and keeps polling the other pages', async () => {
    await expect(poll()).resolves.toBeUndefined();
    expect(mockDb.upsert).toHaveBeenCalledTimes(2);
    expect(mockDb.updateMany).toHaveBeenCalledTimes(1);
  });

  it('skips a page whose upsert rejects, without rejecting the poll', async () => {
    mockDb.upsert.mockRejectedValueOnce(new Error('Connection terminated'));
    await expect(poll()).resolves.toBeUndefined();
    expect(mockDb.upsert).toHaveBeenCalledTimes(2);
    expect(mockDb.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pageUrl: { in: ['https://hyperliquid.gitbook.io/hyperliquid-docs/b'] } } }),
    );
  });

  it('logs and resolves when the page list cannot be read', async () => {
    mockDb.findMany.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    await expect(poll()).resolves.toBeUndefined();
    expect(logDeduplicator.error).toHaveBeenCalled();
    expect(mockDb.upsert).not.toHaveBeenCalled();
  });

  it('logs and resolves when the final updateMany rejects', async () => {
    mockDb.updateMany.mockRejectedValueOnce(new Error('Connection terminated'));
    await expect(poll()).resolves.toBeUndefined();
    expect(mockDb.broadcast).toHaveBeenCalled();
    expect(logDeduplicator.error).toHaveBeenCalledWith(
      expect.stringContaining('lastBroadcastAt'),
      expect.anything(),
    );
  });
});
