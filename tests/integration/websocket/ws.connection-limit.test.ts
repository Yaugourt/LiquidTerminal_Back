/**
 * A connection refused by the per-IP cap is closed by the server, but it can
 * still send frames until the close completes. An invalid frame on it (here an
 * unmasked one) must stay contained: before the fix the socket had no 'error'
 * listener, so the frame error was an uncaughtException and the process exited.
 */
import crypto from 'crypto';
import http from 'http';
import net, { AddressInfo } from 'net';
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

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw upgrade on a TCP socket, so the test controls every byte sent after it. */
function rawUpgrade(port: number): Promise<{ socket: net.Socket; received: () => Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes('\r\n\r\n')) resolve({ socket, received: () => Buffer.concat(chunks) });
    });
    socket.on('error', reject);
  });
}

describe('InternalWebSocketServer connection cap', () => {
  let server: http.Server;
  let port: number;
  let wsServer: import('../../../src/websocket/ws.server').InternalWebSocketServer;
  const uncaught: Error[] = [];
  const onUncaught = (error: Error): void => {
    uncaught.push(error);
  };

  beforeEach(async () => {
    jest.resetModules();
    process.env.WS_MAX_CONNECTIONS_PER_IP = '1';
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
    const { InternalWebSocketServer } = require('../../../src/websocket/ws.server');
    wsServer = InternalWebSocketServer.getInstance();
    server = http.createServer();
    wsServer.initialize(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    process.off('uncaughtException', onUncaught);
    wsServer.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.WS_MAX_CONNECTIONS_PER_IP;
  });

  it('contains an invalid frame sent on a refused connection', async () => {
    const first = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      first.once('open', () => resolve());
      first.once('error', reject);
    });
    await tick(50);
    expect(wsServer.getStats().totalConnections).toBe(1);

    // Second connection from the same IP: over the cap of 1, the server closes it.
    const refused = await rawUpgrade(port);
    expect(refused.received().toString('latin1')).toContain('101 Switching Protocols');
    // One unmasked text frame ("hi"): a client frame must be masked.
    refused.socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await tick(200);

    expect(uncaught).toEqual([]);
    // The refused connection never counted, and the first one is still served.
    expect(wsServer.getStats().totalConnections).toBe(1);
    const pong = new Promise<string>((resolve) => first.once('message', (data) => resolve(String(data))));
    first.send(JSON.stringify({ method: 'ping' }));
    expect(await pong).toContain('heartbeat');

    refused.socket.destroy();
    first.close();
  }, 15_000);
});
