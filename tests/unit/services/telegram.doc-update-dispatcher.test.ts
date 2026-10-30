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
    mockDb.upsert.mockReset();
    mockDb.broadcast.mockReset();
    mockDb.broadcast.mockReturnValue(1);
    mockDb.upsert.mockResolvedValue({});
    mockDb.findMany.mockResolvedValue([
      { pageUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/a', contentHash: 'old', content: 'old' },
      { pageUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/b', contentHash: 'old', content: 'old' },
    ]);
  });

  afterEach(() => jest.useRealTimers());

  const A = 'https://hyperliquid.gitbook.io/hyperliquid-docs/a';
  const B = 'https://hyperliquid.gitbook.io/hyperliquid-docs/b';
  const stored = () => mockDb.upsert.mock.calls.map((c) => (c[0] as { where: { pageUrl: string } }).where.pageUrl);

  it('skips a malformed URL and keeps polling the other pages', async () => {
    await expect(poll()).resolves.toBeUndefined();
    expect(stored()).toEqual([A, B]);
  });

  it('stores a changed page only after its alert was broadcast', async () => {
    const order: string[] = [];
    mockDb.broadcast.mockImplementation(() => { order.push('broadcast'); return 1; });
    mockDb.upsert.mockImplementation(async () => { order.push('upsert'); return {}; });
    await poll();
    expect(order[0]).toBe('broadcast');
    expect(order.filter((o) => o === 'upsert')).toHaveLength(2);
  });

  it('keeps the old hash (stores nothing) when nobody received the alert, so the next poll retries', async () => {
    mockDb.broadcast.mockReturnValue(0); // bot disconnected
    await expect(poll()).resolves.toBeUndefined();
    expect(mockDb.upsert).not.toHaveBeenCalled();
  });

  it('keeps the old hash when the broadcast throws', async () => {
    mockDb.broadcast.mockImplementation(() => { throw new Error('socket'); });
    await expect(poll()).resolves.toBeUndefined();
    expect(mockDb.upsert).not.toHaveBeenCalled();
  });

  it('stores a first-seen page immediately and announces nothing for it', async () => {
    mockDb.findMany.mockResolvedValue([]);
    await poll();
    expect(stored()).toEqual([A, B]);
    expect(mockDb.broadcast).not.toHaveBeenCalled();
  });

  it('does not re-announce on the following poll once delivered', async () => {
    await poll();
    const hashes = mockDb.upsert.mock.calls.map((c) => (c[0] as { update: { contentHash: string } }).update.contentHash);
    mockDb.broadcast.mockClear();
    mockDb.findMany.mockResolvedValue([
      { pageUrl: A, contentHash: hashes[0], content: 'x' },
      { pageUrl: B, contentHash: hashes[1], content: 'x' },
    ]);
    await poll();
    expect(mockDb.broadcast).not.toHaveBeenCalled();
  });

  it('skips a page whose commit rejects, without rejecting the poll', async () => {
    mockDb.upsert.mockRejectedValueOnce(new Error('Connection terminated'));
    await expect(poll()).resolves.toBeUndefined();
    expect(stored()).toEqual([A, B]);
    expect(logDeduplicator.error).toHaveBeenCalled();
  });

  it('logs and resolves when the page list cannot be read', async () => {
    mockDb.findMany.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    await expect(poll()).resolves.toBeUndefined();
    expect(logDeduplicator.error).toHaveBeenCalled();
    expect(mockDb.upsert).not.toHaveBeenCalled();
  });
});
