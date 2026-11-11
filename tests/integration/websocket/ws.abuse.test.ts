/**
 * /ws against a client that abuses it: the caps count per client key (an IPv6
 * /64, not each of its addresses), new connections are counted per minute, a
 * browser from another site is refused, and a public socket that floods frames
 * is closed instead of being answered for ever.
 */
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

const BOT_KEY = 'test-bot-key-0123456789';
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { open: true; ws: WebSocket } | { open: false; status: number; retryAfter?: string };

describe('InternalWebSocketServer against abuse', () => {
  let server: http.Server;
  let port: number;
  let wsServer: import('../../../src/websocket/ws.server').InternalWebSocketServer;
  const opened: WebSocket[] = [];
  const ENV = ['WS_MAX_CONNECTIONS_PER_IP', 'WS_MAX_CONNECTIONS_PER_MINUTE', 'WS_CHECK_ORIGIN', 'TELEGRAM_BOT_API_KEY'];

  async function start(env: Record<string, string> = {}): Promise<void> {
    jest.resetModules();
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const { InternalWebSocketServer } = require('../../../src/websocket/ws.server');
    wsServer = InternalWebSocketServer.getInstance();
    server = http.createServer();
    wsServer.initialize(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  }

  /** Opens a socket as `ip` (the address the edge proxy would append), with optional extra headers. */
  function connect(ip: string, headers: Record<string, string> = {}): Promise<Outcome> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'X-Forwarded-For': ip, ...headers } });
      ws.once('open', () => {
        opened.push(ws);
        resolve({ open: true, ws });
      });
      ws.once('unexpected-response', (_req, res) => {
        resolve({ open: false, status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string | undefined });
        res.resume();
      });
      ws.once('error', () => undefined);
    });
  }

  /** Everything a socket receives, and how it closed. */
  function watch(ws: WebSocket): { messages: Array<Record<string, unknown>>; closed: Promise<number> } {
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    return { messages, closed };
  }

  afterEach(async () => {
    for (const ws of opened.splice(0)) ws.terminate();
    wsServer.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const k of ENV) delete process.env[k];
    jest.restoreAllMocks();
  });

  it('counts the open sockets of an IPv6 client per /64, and an IPv4-mapped address as its IPv4', async () => {
    await start({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    expect((await connect('2001:db8:1:2::1')).open).toBe(true);
    // Another address of the same /64 is the same client.
    expect(await connect('2001:db8:1:2:ffff:ffff:ffff:9')).toMatchObject({ open: false, status: 429 });
    // Another /64 is another client.
    expect((await connect('2001:db8:1:3::1')).open).toBe(true);

    expect((await connect('::ffff:198.51.100.5')).open).toBe(true);
    expect(await connect('198.51.100.5')).toMatchObject({ open: false, status: 429 });
    expect(wsServer.getStats()).toMatchObject({ totalConnections: 3, uniqueIps: 3 });
  });

  it('counts new connections per client per minute, closed ones included', async () => {
    await start({ WS_MAX_CONNECTIONS_PER_MINUTE: '3' });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    for (let i = 0; i < 3; i++) {
      const outcome = await connect('198.51.100.20');
      expect(outcome.open).toBe(true);
      if (outcome.open) {
        const closed = new Promise<void>((resolve) => outcome.ws.once('close', () => resolve()));
        outcome.ws.close(1000);
        await closed;
      }
    }
    await tick(20);
    expect(wsServer.getStats().totalConnections).toBe(0);
    // Nothing is open, but this client has had its connections of the minute.
    expect(await connect('198.51.100.20')).toEqual({ open: false, status: 429, retryAfter: '60' });
    expect((await connect('198.51.100.21')).open).toBe(true);
    // Next minute: it connects again.
    now.mockReturnValue(1_800_000_000_000 + 60_000);
    expect((await connect('198.51.100.20')).open).toBe(true);
  });

  it('refuses a browser from another site, accepts our pages and clients that are not browsers', async () => {
    await start();
    expect(await connect('198.51.100.30', { Origin: 'https://evil.example' })).toMatchObject({ open: false, status: 403 });
    expect((await connect('198.51.100.30', { Origin: 'https://liquidterminal.xyz' })).open).toBe(true);
    expect((await connect('198.51.100.30')).open).toBe(true);
    // The refused attempt opened nothing.
    expect(wsServer.getStats().totalConnections).toBe(2);
  });

  it('can have the origin check switched off', async () => {
    await start({ WS_CHECK_ORIGIN: 'false' });
    expect((await connect('198.51.100.31', { Origin: 'https://evil.example' })).open).toBe(true);
  });

  it('answers the first frame over the limit once, and closes a socket that keeps flooding', async () => {
    await start();
    const outcome = await connect('198.51.100.40');
    if (!outcome.open) throw new Error('not connected');
    const { messages, closed } = watch(outcome.ws);
    const ping = JSON.stringify({ method: 'ping' });

    // 15 frames in the same second: 10 answered, one error for the 11th, nothing for the next four.
    for (let i = 0; i < 15; i++) outcome.ws.send(ping);
    await tick(100);
    expect(messages.filter((m) => m.type === 'heartbeat')).toHaveLength(10);
    expect(messages.filter((m) => m.code === 'RATE_LIMIT')).toHaveLength(1);
    expect(outcome.ws.readyState).toBe(WebSocket.OPEN);

    // 20 more in that second pass the tolerance: closed, not answered.
    for (let i = 0; i < 20; i++) outcome.ws.send(ping);
    expect(await closed).toBe(1008);
    expect(messages.filter((m) => m.code === 'RATE_LIMIT')).toHaveLength(1);
    await tick(20);
    expect(wsServer.getStats().totalConnections).toBe(0);
  });

  it('closes a socket that goes over the limit second after second', async () => {
    await start();
    let clock = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const outcome = await connect('198.51.100.41');
    if (!outcome.open) throw new Error('not connected');
    const { messages, closed } = watch(outcome.ws);
    const ping = JSON.stringify({ method: 'ping' });

    // Twelve frames a second: two over the limit each time, never enough to be closed at once.
    for (let second = 0; second < 4; second++) {
      for (let i = 0; i < 12; i++) outcome.ws.send(ping);
      await tick(60);
      clock += 1_001;
    }
    expect(outcome.ws.readyState).toBe(WebSocket.OPEN);
    expect(messages.filter((m) => m.code === 'RATE_LIMIT')).toHaveLength(4);
    // The fifth second over the limit in a row.
    for (let i = 0; i < 12; i++) outcome.ws.send(ping);
    expect(await closed).toBe(1008);
  });

  it('forgives a socket that comes back under the limit', async () => {
    await start();
    let clock = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const outcome = await connect('198.51.100.42');
    if (!outcome.open) throw new Error('not connected');
    const { messages } = watch(outcome.ws);
    const ping = JSON.stringify({ method: 'ping' });
    // Four seconds over, one quiet second, four more over: never five in a row.
    for (let second = 0; second < 9; second++) {
      for (let i = 0; i < (second === 4 ? 3 : 12); i++) outcome.ws.send(ping);
      await tick(60);
      clock += 1_001;
    }
    expect(outcome.ws.readyState).toBe(WebSocket.OPEN);
    expect(messages.filter((m) => m.code === 'RATE_LIMIT')).toHaveLength(8);
  });

  it('never closes the authenticated bot for its rate: it is told, and kept', async () => {
    await start({ TELEGRAM_BOT_API_KEY: BOT_KEY });
    const outcome = await connect('198.51.100.43', { Authorization: `Bot ${BOT_KEY}` });
    if (!outcome.open) throw new Error('not connected');
    const { messages } = watch(outcome.ws);
    for (let i = 0; i < 60; i++) outcome.ws.send(JSON.stringify({ method: 'ping' }));
    await tick(150);
    expect(outcome.ws.readyState).toBe(WebSocket.OPEN);
    expect(messages.filter((m) => m.type === 'heartbeat')).toHaveLength(10);
    expect(messages.filter((m) => m.code === 'RATE_LIMIT').length).toBeGreaterThan(0);
  });

  it('does not send a client its own message back in an error', async () => {
    await start();
    const outcome = await connect('198.51.100.44');
    if (!outcome.open) throw new Error('not connected');
    const { messages } = watch(outcome.ws);
    const method = 'x'.repeat(60_000);
    outcome.ws.send(JSON.stringify({ method }));
    await tick(100);
    const error = messages.find((m) => m.code === 'UNKNOWN_METHOD');
    expect(error).toMatchObject({ type: 'error', error: 'Unknown method' });
    expect(JSON.stringify(error).length).toBeLessThan(200);
  });
});
