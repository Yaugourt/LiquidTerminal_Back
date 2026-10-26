/**
 * /ws bot authentication: the `Authorization: Bot <key>` header always works;
 * the `?key=` URL fallback works by default (the bot may still use it), logs a
 * warning, and is refused once WS_ALLOW_BOT_KEY_IN_QUERY=false.
 */
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

const BOT_KEY = 'test-bot-key-0123456789';

const mockWarn = jest.fn();
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/liquidations/liquidations.ws.service', () => ({
  LiquidationsWebSocketService: { getInstance: () => ({ onProcessedLiquidation: () => undefined }) },
}));
jest.mock('../../../src/services/liquidations/sse-manager.service', () => ({
  SSEManagerService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/orderbook/l4book.service', () => ({
  L4BookService: {
    getInstance: () => ({
      onSnapshot: () => undefined,
      onDelta: () => undefined,
      onUnavailable: () => undefined,
      shutdown: () => undefined,
    }),
  },
}));

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects, asks for a privileged channel and reports whether it was granted. */
async function privilegedGranted(port: number, path: string, headers?: Record<string, string>): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const messages: Array<Record<string, any>> = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'alert' } }));
  await tick(50);
  ws.close();
  return !messages.some((m) => m.type === 'error' && m.code === 'UNAUTHORIZED');
}

const queryWarnings = (): unknown[][] =>
  mockWarn.mock.calls.filter(([message]) => String(message).includes('?key='));

describe('InternalWebSocketServer bot authentication', () => {
  let server: http.Server;
  let port: number;
  let wsServer: import('../../../src/websocket/ws.server').InternalWebSocketServer;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    process.env.TELEGRAM_BOT_API_KEY = BOT_KEY;
    delete process.env.TELEGRAM_BOT_API_KEY_SECONDARY;
    delete process.env.WS_ALLOW_BOT_KEY_IN_QUERY;
    mockWarn.mockClear();
    jest.resetModules();
    const { InternalWebSocketServer } = require('../../../src/websocket/ws.server');
    wsServer = InternalWebSocketServer.getInstance();
    server = http.createServer();
    wsServer.initialize(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    wsServer.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
  });

  it('accepts the Authorization header and does not warn', async () => {
    expect(await privilegedGranted(port, '/ws', { Authorization: `Bot ${BOT_KEY}` })).toBe(true);
    expect(queryWarnings()).toHaveLength(0);
  });

  it('refuses a connection with no key', async () => {
    expect(await privilegedGranted(port, '/ws')).toBe(false);
  });

  it('accepts ?key= by default and logs a warning without the key or the URL', async () => {
    expect(await privilegedGranted(port, `/ws?key=${BOT_KEY}`)).toBe(true);
    const warnings = queryWarnings();
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).not.toContain(BOT_KEY);
    expect(JSON.stringify(warnings[0])).not.toContain('/ws?');
  });

  it('refuses a wrong ?key= without warning', async () => {
    expect(await privilegedGranted(port, '/ws?key=nope')).toBe(false);
    expect(queryWarnings()).toHaveLength(0);
  });

  it('refuses ?key= when WS_ALLOW_BOT_KEY_IN_QUERY=false, but keeps the header working', async () => {
    process.env.WS_ALLOW_BOT_KEY_IN_QUERY = 'false';
    expect(await privilegedGranted(port, `/ws?key=${BOT_KEY}`)).toBe(false);
    expect(queryWarnings()).toHaveLength(0);
    expect(await privilegedGranted(port, '/ws', { Authorization: `Bot ${BOT_KEY}` })).toBe(true);
  });
});
