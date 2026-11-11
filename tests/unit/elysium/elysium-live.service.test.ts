/**
 * The live block stream (mainnet newHeads over WebSocket). A socket that is open is not a stream
 * that works: it could stay open and silent until the next restart, and a node that accepted the
 * socket and then closed it was reconnected to every second, for ever (2026-11-11).
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { EventEmitter } from 'events';

class FakeSocket extends EventEmitter {
  public sent: string[] = [];
  public terminated = false;
  public closed = false;
  /** As the real socket does: 'close' comes later, not from inside close(). */
  public closesLater = false;
  constructor(
    public readonly url: string,
    public readonly options: { handshakeTimeout?: number }
  ) {
    super();
    mockSockets.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.terminated = true;
    this.emit('close');
  }
  close(): void {
    this.closed = true;
    if (!this.closesLater) this.emit('close');
  }
  block(n: number): void {
    this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { result: { number: `0x${n.toString(16)}`, timestamp: '0x1', gasUsed: '0x2', gasLimit: '0x3' } } })));
  }
}
const mockSockets: FakeSocket[] = [];
jest.mock('ws', () => ({ WebSocket: FakeSocket }));

import { ElysiumLiveService } from '../../../src/services/elysium/elysium-live.service';

describe('ElysiumLiveService', () => {
  let svc: ElysiumLiveService;
  const last = (): FakeSocket => mockSockets[mockSockets.length - 1];

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00Z') });
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: the reconnect waits are their step
    mockSockets.length = 0;
    process.env.ELYSIUM_MAINNET_WS_URL = 'wss://node.example/key';
    (ElysiumLiveService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumLiveService.getInstance();
  });
  afterEach(() => {
    svc.stop();
    delete process.env.ELYSIUM_MAINNET_WS_URL;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('opens the socket with a handshake time limit and subscribes to new heads', () => {
    svc.start();
    expect(mockSockets).toHaveLength(1);
    expect(last().options.handshakeTimeout).toBe(10_000);
    last().emit('open');
    expect(JSON.parse(last().sent[0])).toMatchObject({ method: 'eth_subscribe', params: ['newHeads'] });
  });

  it('hands the blocks to its listeners, batched once a second', async () => {
    const got: number[][] = [];
    svc.onBlocks((blocks) => got.push(blocks.map((b) => b.number)));
    svc.start();
    last().emit('open');
    last().block(10);
    last().block(11);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(got).toEqual([[11, 10]]);
  });

  it('closes a socket that is open and gives no block for 15 seconds, and opens another', async () => {
    svc.start();
    const first = last();
    first.emit('open');
    first.block(1);
    await jest.advanceTimersByTimeAsync(14_000);
    expect(first.terminated).toBe(false);
    await jest.advanceTimersByTimeAsync(7_000);
    expect(first.terminated).toBe(true);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(mockSockets).toHaveLength(2);
  });

  it('keeps a socket that gives blocks', async () => {
    svc.start();
    const socket = last();
    socket.emit('open');
    for (let i = 0; i < 12; i++) {
      socket.block(i);
      await jest.advanceTimersByTimeAsync(5_000);
    }
    expect(socket.terminated).toBe(false);
    expect(mockSockets).toHaveLength(1);
  });

  it('closes a socket whose subscription the node refuses', () => {
    svc.start();
    const socket = last();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'the method eth_subscribe does not exist' } })));
    expect(socket.terminated).toBe(true);
  });

  it('a node that accepts the socket and closes it at once is reconnected to with a growing wait, not every second', async () => {
    svc.start();
    const waits: number[] = [];
    let at = Date.now();
    for (let i = 0; i < 6; i++) {
      const socket = last();
      socket.emit('open');
      socket.emit('close');
      const before = mockSockets.length;
      while (mockSockets.length === before) await jest.advanceTimersByTimeAsync(500);
      waits.push(Date.now() - at);
      at = Date.now();
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  });

  it('starts the wait over once a socket has given blocks for 30 seconds', async () => {
    svc.start();
    for (let i = 0; i < 4; i++) {
      last().emit('open');
      last().emit('close');
      const before = mockSockets.length;
      while (mockSockets.length === before) await jest.advanceTimersByTimeAsync(500);
    }
    // This one works for a while, then drops.
    const working = last();
    working.emit('open');
    for (let s = 0; s < 31; s++) {
      working.block(7 + s);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    working.block(99);
    const dropped = Date.now();
    working.emit('close');
    const before = mockSockets.length;
    while (mockSockets.length === before) await jest.advanceTimersByTimeAsync(500);
    expect(Date.now() - dropped).toBe(1_000);
  });

  it('a node that gives one block and closes, every time, is not reconnected to every second either', async () => {
    svc.start();
    const waits: number[] = [];
    let at = Date.now();
    for (let i = 0; i < 5; i++) {
      const socket = last();
      socket.emit('open');
      socket.block(i);
      socket.emit('close');
      const before = mockSockets.length;
      while (mockSockets.length === before) await jest.advanceTimersByTimeAsync(500);
      waits.push(Date.now() - at);
      at = Date.now();
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('the late close of a socket let go of by a stop does not undo the socket opened since', async () => {
    svc.start();
    const first = last();
    first.closesLater = true;
    first.emit('open');
    svc.stop();
    svc.start();
    const second = last();
    expect(second).not.toBe(first);
    second.emit('open');
    // The first socket's 'close' arrives now, and one last frame of it with it.
    first.block(1);
    first.emit('close');
    await jest.advanceTimersByTimeAsync(5_000);
    // No third socket was opened for it.
    expect(mockSockets).toHaveLength(2);
    // And the second one is still watched: silent for 15 seconds, it is closed and replaced.
    await jest.advanceTimersByTimeAsync(16_000);
    expect(second.terminated).toBe(true);
    expect(mockSockets).toHaveLength(3);
  });

  it('spreads the reconnections between 80% and 120% of the wait', async () => {
    (Math.random as jest.Mock).mockReturnValue(0);
    svc.start();
    last().emit('open');
    last().emit('close');
    await jest.advanceTimersByTimeAsync(799);
    expect(mockSockets).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(2);
    expect(mockSockets).toHaveLength(2);
  });

  it('stops for good when stopped: no watchdog, no reconnection', async () => {
    svc.start();
    last().emit('open');
    svc.stop();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockSockets).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
