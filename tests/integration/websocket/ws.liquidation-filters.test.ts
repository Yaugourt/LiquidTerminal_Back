/**
 * /ws liquidation filters: invalid filters are refused with an error message
 * (nothing stored), valid ones keep filtering, and one client whose stored
 * filters throw inside the broadcast can never stop delivery to the clients
 * after it.
 */
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

const mockState = {
  onLiquidation: null as ((liquidations: unknown[]) => void) | null,
};

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/liquidations/liquidations.ws.service', () => ({
  LiquidationsWebSocketService: {
    getInstance: () => ({
      onProcessedLiquidation: (cb: (liquidations: unknown[]) => void) => {
        mockState.onLiquidation = cb;
      },
    }),
  },
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

const liq = (coin: string, notional = 1_000) => ({
  tid: 1,
  time_ms: 1_790_000_000_000,
  coin,
  liquidated_user: '0xabc0000000000000000000000000000000000001',
  notional_total: notional,
});

interface Client {
  ws: WebSocket;
  messages: Array<Record<string, any>>;
  liquidations: () => string[];
}

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const client: Client = {
    ws,
    messages: [],
    liquidations: () => client.messages.filter((m) => m.type === 'liquidation').map((m) => m.data.coin),
  };
  ws.on('message', (data) => client.messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
}

async function subscribe(client: Client, filters?: unknown): Promise<void> {
  client.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'liquidation', filters } }));
  await tick(50);
}

describe('InternalWebSocketServer liquidation filters', () => {
  let server: http.Server;
  let port: number;
  let wsServer: import('../../../src/websocket/ws.server').InternalWebSocketServer;

  beforeEach(async () => {
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
  });

  it.each([
    ['coins as a string', { coins: 'BTC' }],
    ['coins holding a number', { coins: [1] }],
    ['a negative minAmountUsd', { minAmountUsd: -5 }],
    ['filters as an array', ['BTC']],
  ])('refuses %s with an error and stores nothing', async (_label, filters) => {
    const bad = await connect(port);
    const good = await connect(port);
    await subscribe(bad, filters);
    await subscribe(good);

    const error = bad.messages.find((m) => m.type === 'error');
    expect(error).toMatchObject({ code: 'INVALID_FILTERS' });
    expect(bad.messages.some((m) => m.type === 'subscribed')).toBe(false);

    mockState.onLiquidation?.([liq('BTC')]);
    await tick(50);
    expect(bad.liquidations()).toEqual([]);
    expect(good.liquidations()).toEqual(['BTC']);
    bad.ws.close();
    good.ws.close();
  });

  it('keeps the previous filters when an update is refused', async () => {
    const c = await connect(port);
    await subscribe(c, { coins: ['eth'] });
    await subscribe(c, { coins: 'BTC' });
    expect(c.messages.filter((m) => m.type === 'error')).toHaveLength(1);

    mockState.onLiquidation?.([liq('BTC'), liq('ETH')]);
    await tick(50);
    expect(c.liquidations()).toEqual(['ETH']);
    c.ws.close();
  });

  it('still filters by coins (case-insensitive), minimum amount and wallets', async () => {
    const coins = await connect(port);
    const min = await connect(port);
    const wallet = await connect(port);
    const none = await connect(port);
    await subscribe(coins, { coins: ['btc'] });
    await subscribe(min, { minAmountUsd: 10_000 });
    await subscribe(wallet, { wallets: ['0xABC0000000000000000000000000000000000001'] });
    await subscribe(none, {});

    mockState.onLiquidation?.([liq('BTC', 500), liq('ETH', 50_000)]);
    await tick(50);

    expect(coins.liquidations()).toEqual(['BTC']);
    expect(min.liquidations()).toEqual(['ETH']);
    expect(wallet.liquidations()).toEqual(['BTC', 'ETH']);
    expect(none.liquidations()).toEqual(['BTC', 'ETH']);
    expect(coins.messages.find((m) => m.type === 'subscribed')?.data.filters).toEqual({ coins: ['BTC'] });
    [coins, min, wallet, none].forEach((c) => c.ws.close());
  });

  it('keeps delivering to later clients when an earlier client throws in the broadcast', async () => {
    const poisoned = await connect(port);
    const later = await connect(port);
    await subscribe(poisoned);
    await subscribe(later);

    // Defense in depth: bypass the subscribe validation to put a malformed
    // filter set on the first client, as a past bug or a new code path could.
    const clients = (wsServer as unknown as { clients: Map<string, { subscriptions: Array<{ type: string; filters: unknown }> }> }).clients;
    const first = [...clients.values()][0];
    first.subscriptions.find((s) => s.type === 'liquidation')!.filters = { coins: 'BTC' };

    mockState.onLiquidation?.([liq('BTC')]);
    await tick(50);

    expect(poisoned.liquidations()).toEqual([]);
    expect(later.liquidations()).toEqual(['BTC']);
    poisoned.ws.close();
    later.ws.close();
  });
});
