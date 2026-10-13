/**
 * The positions stream caps connections per IP (3). A client that disconnects
 * before or while the upstream stream opens must not keep its slot — otherwise
 * a few aborted requests lock the IP (and 200 of them, everyone) out.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import http from 'http';
import type { AddressInfo, Socket } from 'net';

jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  passthroughRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(),
  },
}));

jest.mock('../../../src/clients/hyperfolio/hyperfolio-api.config', () => ({
  ...jest.requireActual('../../../src/clients/hyperfolio/hyperfolio-api.config'),
  isHyperfolioConfigured: () => true,
}));

const mockService = {
  peekPositions: jest.fn(),
  isRateLimited: jest.fn().mockReturnValue(false),
  storePositions: jest.fn().mockResolvedValue(undefined),
  markRateLimited: jest.fn(),
};

jest.mock('../../../src/services/hyperfolio/hyperfolio.service', () => ({
  HyperfolioService: { getInstance: () => mockService },
}));

const mockClient = {
  openPositionsStream: jest.fn(),
  checkRateLimit: jest.fn().mockReturnValue(true),
};

jest.mock('../../../src/clients/hyperfolio/hyperfolio.client', () => ({
  HyperfolioClient: { getInstance: () => mockClient },
}));

import hyperfolioRoutes from '../../../src/routes/hyperfolio/hyperfolio.routes';

const ADDRESS = '0x32309802C8feb2306240893BD79A2E4ba5314e55';
const PATH = `/hyperfolio/wallet/${ADDRESS}/positions/stream`;

function completeStream(): ReadableStream<Uint8Array> {
  const frame = `data: ${JSON.stringify({ type: 'complete', portfolioStats: {} })}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Polls `done` until it holds, failing after 2 s: waits on what the server
 * actually did instead of a fixed delay (which lost the race under load).
 */
async function waitFor(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Lets the route's pending continuations and close handlers run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('GET /hyperfolio/.../positions/stream — slot release', () => {
  let server: http.Server;
  let port: number;
  /** Server-side sockets still open. */
  const serverSockets = new Set<Socket>();

  beforeAll(async () => {
    const app = express();
    app.use('/hyperfolio', hyperfolioRoutes);
    server = http.createServer(app);
    server.on('connection', (socket) => {
      serverSockets.add(socket);
      socket.on('close', () => serverSockets.delete(socket));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockService.isRateLimited.mockReturnValue(false);
    mockClient.checkRateLimit.mockReturnValue(true);
  });

  /**
   * Opens the stream, destroys the socket once `whenPending` resolves, and
   * returns once the server has seen the close (its handlers have run).
   */
  async function abortedRequest(whenPending: Promise<void>): Promise<void> {
    // No keep-alive agent: every request has its own socket, closed with it.
    const req = http.get({ host: '127.0.0.1', port, path: PATH, agent: false });
    req.on('error', () => undefined);
    await whenPending;
    req.destroy();
    await waitFor(() => serverSockets.size === 0, 'the server to see the client close');
    await settle();
  }

  function fullRequest(): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: PATH, agent: false }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
  }

  it('does not leak a slot when the client leaves during the cache peek', async () => {
    for (let i = 0; i < 4; i += 1) {
      const peek = deferred<null>();
      const called = deferred<void>();
      mockService.peekPositions.mockImplementationOnce(() => {
        called.resolve();
        return peek.promise;
      });
      await abortedRequest(called.promise);
      peek.resolve(null);
      await settle();
    }
    expect(mockClient.openPositionsStream).not.toHaveBeenCalled();

    mockService.peekPositions.mockResolvedValue(null);
    mockClient.openPositionsStream.mockResolvedValue(completeStream());
    const res = await fullRequest();
    expect(res.status).toBe(200);
    expect(res.body).toContain('"type":"complete"');
  });

  it('does not leak a slot when the client leaves while the upstream opens', async () => {
    mockService.peekPositions.mockResolvedValue(null);
    const cancels: jest.Mock[] = [];
    for (let i = 0; i < 4; i += 1) {
      const open = deferred<ReadableStream<Uint8Array>>();
      const called = deferred<void>();
      mockClient.openPositionsStream.mockImplementationOnce(() => {
        called.resolve();
        return open.promise;
      });
      await abortedRequest(called.promise);
      const stream = completeStream();
      const cancel = jest.fn().mockResolvedValue(undefined);
      stream.cancel = cancel;
      cancels.push(cancel);
      open.resolve(stream);
      await waitFor(() => cancel.mock.calls.length > 0, 'the late upstream stream to be cancelled');
    }
    cancels.forEach((cancel) => expect(cancel).toHaveBeenCalled());

    mockClient.openPositionsStream.mockResolvedValue(completeStream());
    const res = await fullRequest();
    expect(res.status).toBe(200);
    expect(res.body).toContain('"type":"complete"');
  });
});
