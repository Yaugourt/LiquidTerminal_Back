/**
 * The public `twap` channel of /ws: subscribing answers `subscribed` then the
 * book's snapshot (to that client only); the 1 s delta is serialized once and
 * reaches only the clients subscribed to `twap`; the book is asked for deltas
 * only while somebody is subscribed. The snapshot is serialized once a second
 * for all subscribers and a client gets one every 5 s at most.
 */
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

const mockState = {
  snapshotCalls: 0,
  deltaListeners: new Set<(delta: unknown) => void>(),
  snapshot: {
    entries: [{ twapId: 1, executedSz: 2, executedNtl: 200, fills: 1, lastFillAt: 5, lastPx: 100, exact: true }],
    upstream: { connected: true, since: 1 },
    at: 10,
  },
};

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
jest.mock('../../../src/services/twap/twap-live.service', () => ({
  TwapLiveService: {
    getInstance: () => ({
      getSnapshot: () => {
        mockState.snapshotCalls++;
        return mockState.snapshot;
      },
      onDelta: (cb: (delta: unknown) => void) => {
        mockState.deltaListeners.add(cb);
        return () => mockState.deltaListeners.delete(cb);
      },
    }),
  },
}));

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Client {
  ws: WebSocket;
  messages: Array<{ type: string; data?: unknown; code?: string; error?: string }>;
}

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const client: Client = { ws, messages: [] };
  ws.on('message', (data) => client.messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
}

const send = async (client: Client, message: unknown): Promise<void> => {
  client.ws.send(JSON.stringify(message));
  await tick(50);
};
const types = (client: Client): string[] => client.messages.map((m) => m.type).filter((t) => t !== 'connected');
const delta = { entries: [{ twapId: 1, executedSz: 3 }], removed: [9], upstream: { connected: true, since: 1 }, at: 20 };
const emit = (): void => {
  for (const listener of mockState.deltaListeners) listener(delta);
};

describe('InternalWebSocketServer twap channel', () => {
  let server: http.Server;
  let port: number;
  let wsServer: import('../../../src/websocket/ws.server').InternalWebSocketServer;

  // The server reads Date.now(): the tests move it instead of waiting.
  let skew = 0;
  const realNow = Date.now.bind(Date);

  beforeEach(async () => {
    jest.resetModules();
    mockState.deltaListeners.clear();
    mockState.snapshotCalls = 0;
    skew = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    const { InternalWebSocketServer } = require('../../../src/websocket/ws.server');
    wsServer = InternalWebSocketServer.getInstance();
    server = http.createServer();
    wsServer.initialize(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    wsServer.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers a public subscribe with subscribed, then the snapshot', async () => {
    const client = await connect(port);
    await send(client, { method: 'subscribe', subscription: { type: 'twap' } });

    expect(types(client)).toEqual(['subscribed', 'twap_snapshot']);
    expect(client.messages.find((m) => m.type === 'subscribed')?.data).toEqual({ type: 'twap', filters: {} });
    expect(client.messages.find((m) => m.type === 'twap_snapshot')?.data).toEqual(mockState.snapshot);
    expect(wsServer.getStats().subscriptionsByType.twap).toBe(1);
    client.ws.close();
  });

  it('sends the snapshot to the subscribing client only', async () => {
    const watcher = await connect(port);
    await send(watcher, { method: 'subscribe', subscription: { type: 'twap' } });
    const other = await connect(port);
    await send(other, { method: 'subscribe', subscription: { type: 'liquidation' } });
    const late = await connect(port);
    await send(late, { method: 'subscribe', subscription: { type: 'twap' } });

    expect(types(watcher).filter((t) => t === 'twap_snapshot')).toHaveLength(1);
    expect(types(other)).toEqual(['subscribed']);
    expect(types(late)).toEqual(['subscribed', 'twap_snapshot']);
    [watcher, other, late].forEach((c) => c.ws.close());
  });

  it('re-sends a snapshot when a subscribed client subscribes again, but not inside the 5 s window', async () => {
    const client = await connect(port);
    await send(client, { method: 'subscribe', subscription: { type: 'twap' } });
    await send(client, { method: 'subscribe', subscription: { type: 'twap' } });
    // Inside the window: acknowledged, no new snapshot.
    expect(types(client)).toEqual(['subscribed', 'twap_snapshot', 'subscribed']);

    skew += 5_001;
    await send(client, { method: 'subscribe', subscription: { type: 'twap' } });
    expect(types(client)).toEqual(['subscribed', 'twap_snapshot', 'subscribed', 'subscribed', 'twap_snapshot']);
    expect(wsServer.getStats().subscriptionsByType.twap).toBe(1);
    client.ws.close();
  });

  it('applies the window per client', async () => {
    const a = await connect(port);
    const b = await connect(port);
    await send(a, { method: 'subscribe', subscription: { type: 'twap' } });
    await send(b, { method: 'subscribe', subscription: { type: 'twap' } });
    expect(types(a)).toEqual(['subscribed', 'twap_snapshot']);
    expect(types(b)).toEqual(['subscribed', 'twap_snapshot']);
    [a, b].forEach((c) => c.ws.close());
  });

  it('serializes the snapshot once a second for all subscribers', async () => {
    const clients = [await connect(port), await connect(port), await connect(port)];
    for (const c of clients) await send(c, { method: 'subscribe', subscription: { type: 'twap' } });
    expect(mockState.snapshotCalls).toBe(1);
    for (const c of clients) expect(c.messages.find((m) => m.type === 'twap_snapshot')?.data).toEqual(mockState.snapshot);

    skew += 1_001;
    const late = await connect(port);
    await send(late, { method: 'subscribe', subscription: { type: 'twap' } });
    expect(mockState.snapshotCalls).toBe(2);
    expect(types(late)).toEqual(['subscribed', 'twap_snapshot']);
    [...clients, late].forEach((c) => c.ws.close());
  });

  it('broadcasts a delta to twap subscribers only', async () => {
    const watcher = await connect(port);
    const other = await connect(port);
    await send(watcher, { method: 'subscribe', subscription: { type: 'twap' } });
    await send(other, { method: 'subscribe', subscription: { type: 'liquidation' } });

    emit();
    await tick(50);

    const received = watcher.messages.filter((m) => m.type === 'twap_delta');
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual(delta);
    expect(other.messages.some((m) => m.type === 'twap_delta')).toBe(false);
    [watcher, other].forEach((c) => c.ws.close());
  });

  it('asks the book for deltas only while somebody is subscribed', async () => {
    expect(mockState.deltaListeners.size).toBe(0);
    const a = await connect(port);
    const b = await connect(port);
    await send(a, { method: 'subscribe', subscription: { type: 'twap' } });
    await send(b, { method: 'subscribe', subscription: { type: 'twap' } });
    expect(mockState.deltaListeners.size).toBe(1); // one listener, however many viewers

    await send(a, { method: 'unsubscribe', subscription: { type: 'twap' } });
    expect(mockState.deltaListeners.size).toBe(1);
    emit();
    await tick(50);
    expect(a.messages.some((m) => m.type === 'twap_delta')).toBe(false);
    expect(b.messages.some((m) => m.type === 'twap_delta')).toBe(true);

    b.ws.close();
    await tick(100);
    expect(mockState.deltaListeners.size).toBe(0);
    a.ws.close();
  });

  it('still rejects unknown types and lists twap among the supported ones', async () => {
    const client = await connect(port);
    await send(client, { method: 'subscribe', subscription: { type: 'nope' } });
    const error = client.messages.find((m) => m.type === 'error');
    expect(error?.code).toBe('INVALID_SUBSCRIPTION');
    expect(error?.error).toContain('twap');
    client.ws.close();
  });
});
