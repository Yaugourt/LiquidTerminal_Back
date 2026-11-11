/**
 * ElysiumRpcProxyService: the answer is relayed as received, never past the
 * size ceiling; the forwards in flight, the bytes held and the weight of a
 * minute are capped across all clients, each with a share per client; no error
 * or log line carries the keyed upstream URL.
 */
import { EventEmitter } from 'events';
import type { ServerResponse } from 'http';

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));

const KEYED_URL = 'https://rpc.example.test/elysium/SECRET-KEY-123';

type Service = import('../../../src/services/elysium/elysium-rpc-proxy.service').ElysiumRpcProxyService;
type Module = typeof import('../../../src/services/elysium/elysium-rpc-proxy.service');

function load(env: Record<string, string> = {}): { service: Service; mod: Module } {
  jest.resetModules();
  process.env.ELYSIUM_MAINNET_RPC_URL = KEYED_URL;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = require('../../../src/services/elysium/elysium-rpc-proxy.service') as Module;
  return { service: mod.ElysiumRpcProxyService.getInstance(), mod };
}

/** A fetch Response whose body arrives in `chunks`. */
function response(chunks: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers: init.headers });
}

const CALL = { jsonrpc: '2.0', id: 7, method: 'eth_blockNumber', params: [] };
const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();

type Answer = import('../../../src/services/elysium/elysium-rpc-proxy.service').ElysiumRpcAnswer;
const textOf = (answer: Answer): string => Buffer.concat(answer.chunks).toString('utf8');
/** Forwards, reads the answer as text and releases it at once (a client that read it). */
async function relay(service: Service, body: unknown = CALL, weight = 1, client = ''): Promise<string> {
  const answer = await service.forward(body, weight, client);
  answer.release();
  return textOf(answer);
}
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Enough of a ServerResponse for `deliver`: records what is written, emits finish / close on demand. */
function fakeResponse(): ServerResponse & { written: Buffer[]; headers: Record<string, string>; ended: boolean; destroyed: boolean } {
  const res = new EventEmitter() as unknown as ServerResponse & { written: Buffer[]; headers: Record<string, string>; ended: boolean; destroyed: boolean };
  res.written = [];
  res.headers = {};
  res.ended = false;
  (res as { destroyed: boolean }).destroyed = false;
  res.setHeader = ((name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  }) as ServerResponse['setHeader'];
  res.write = ((chunk: Buffer) => {
    res.written.push(chunk);
    return true;
  }) as ServerResponse['write'];
  res.end = (() => {
    res.ended = true;
    return res;
  }) as ServerResponse['end'];
  res.destroy = (() => {
    (res as { destroyed: boolean }).destroyed = true;
    res.emit('close');
    return res;
  }) as ServerResponse['destroy'];
  return res;
}

describe('ElysiumRpcProxyService', () => {
  const realFetch = global.fetch;
  const ENV_KEYS = [
    'ELYSIUM_RPC_MAX_RESPONSE_BYTES',
    'ELYSIUM_RPC_MAX_IN_FLIGHT',
    'ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT',
    'ELYSIUM_RPC_GLOBAL_PER_MINUTE',
    'ELYSIUM_RPC_MAX_BUFFERED_BYTES',
    'ELYSIUM_RPC_MAX_BUFFERED_BYTES_PER_CLIENT',
    'ELYSIUM_RPC_MAX_WAITING',
    'ELYSIUM_RPC_MAX_WAITING_PER_CLIENT',
  ];

  beforeEach(() => {
    fetchMock.mockReset();
    for (const m of Object.values(mockLog)) m.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
    delete process.env.ELYSIUM_MAINNET_RPC_URL;
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('relays the upstream answer as received, byte for byte', async () => {
    const { service } = load();
    // Key order, spacing and a number past 2^53 would not survive a parse + stringify.
    const upstream = '{"jsonrpc":"2.0", "id":7,\n "result":{"big":12345678901234567890,"hex":"0x1863d"}}';
    fetchMock.mockResolvedValue(response([upstream.slice(0, 20), upstream.slice(20)]));

    const answer = await service.forward(CALL);
    expect(textOf(answer)).toBe(upstream);
    expect(answer.bytes).toBe(Buffer.byteLength(upstream));
    answer.release();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(KEYED_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(CALL);
  });

  it('refuses an answer over the ceiling from its Content-Length, without reading it', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_MAX_RESPONSE_BYTES: '100' });
    const res = response(['{"result":"' + 'a'.repeat(500) + '"}'], { headers: { 'content-length': '513' } });
    const cancel = jest.spyOn(res.body as ReadableStream<Uint8Array>, 'cancel');
    fetchMock.mockResolvedValue(res);

    await expect(service.forward(CALL)).rejects.toBeInstanceOf(mod.ElysiumRpcResponseTooLargeError);
    expect(cancel).toHaveBeenCalled();
  });

  it('stops reading an undeclared body once it passes the ceiling', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_MAX_RESPONSE_BYTES: '100' });
    let pulled = 0;
    const encoder = new TextEncoder();
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(encoder.encode('x'.repeat(40)));
      },
    });
    fetchMock.mockResolvedValue(new Response(endless, { status: 200 }));

    await expect(service.forward(CALL)).rejects.toBeInstanceOf(mod.ElysiumRpcResponseTooLargeError);
    // 3 chunks of 40 bytes pass 100; the stream is cancelled, not drained.
    expect(pulled).toBeLessThan(10);
  });

  it('accepts an answer exactly at the ceiling', async () => {
    const body = '{"result":"' + 'a'.repeat(87) + '"}';
    expect(Buffer.byteLength(body)).toBe(100);
    const { service } = load({ ELYSIUM_RPC_MAX_RESPONSE_BYTES: '100' });
    fetchMock.mockResolvedValue(response([body]));
    await expect(relay(service)).resolves.toBe(body);
  });

  it('caps the forwards in flight across clients, and frees the slot when the answer is released', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_MAX_IN_FLIGHT: '2', ELYSIUM_RPC_MAX_WAITING: '1' });
    const release: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => release.push(resolve)));

    const first = service.forward(CALL, 1, 'a');
    const second = service.forward(CALL, 1, 'b');
    // Both slots taken: a third client waits for one, a fourth finds the waiting room full.
    const third = service.forward(CALL, 1, 'c');
    await turn();
    await expect(service.forward(CALL, 1, 'd')).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    await expect(service.forward(CALL, 1, 'd')).rejects.toMatchObject({ retryAfterS: 1 });
    expect(mockLog.warn).toHaveBeenCalledWith('Elysium RPC proxy: too many forwards in flight', { max: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    release[0](response(['{"result":1}']));
    const answer = await first;
    expect(textOf(answer)).toBe('{"result":1}');
    await turn();
    // The answer is read but not released: its client does not have it yet, the slot is still held.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.load).toMatchObject({ inFlight: 2, waiting: 1, bufferedBytes: 12 });
    answer.release();
    answer.release();
    await turn();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // A failed forward frees its slot too.
    release[2](response(['nope'], { status: 500 }));
    await expect(third).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
    release[1](response(['{"result":2}']));
    (await second).release();
    fetchMock.mockResolvedValue(response(['{"result":3}']));
    await expect(relay(service)).resolves.toBe('{"result":3}');
    expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
  });

  it('gives each client a share of the slots: past it, its calls wait for one of its own, the others pass', async () => {
    const { service, mod } = load({
      ELYSIUM_RPC_MAX_IN_FLIGHT: '4',
      ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT: '2',
      ELYSIUM_RPC_MAX_WAITING_PER_CLIENT: '2',
    });
    const release: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => release.push(resolve)));
    const settle = (p: Promise<Answer>): Promise<string> => p.then((a) => (a.release(), textOf(a)), (e: Error) => e.name);

    // Client a opens a tool: five calls at once. Two run, two wait, the fifth is refused.
    const a = Array.from({ length: 5 }, () => settle(service.forward(CALL, 1, 'a')));
    await turn();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(a[4]).resolves.toBe('ElysiumRpcBusyError');
    // Its own doing: not logged as a shortage of the proxy.
    expect(mockLog.warn).not.toHaveBeenCalled();

    // The others still get through at once, up to the total of 4.
    const b = settle(service.forward(CALL, 1, 'b'));
    const c = settle(service.forward(CALL, 1, 'c'));
    await turn();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // One of a's calls ends: one of its waiting calls starts, no more.
    release[0](response(['{"result":1}']));
    await expect(a[0]).resolves.toBe('{"result":1}');
    await turn();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (let i = 1; i < 5; i++) release[i](response(['{"result":2}']));
    await turn();
    await turn();
    release[5](response(['{"result":3}']));
    await expect(Promise.all([a[1], a[2], a[3], b, c])).resolves.toEqual(['{"result":2}', '{"result":2}', '{"result":3}', '{"result":2}', '{"result":2}']);
    // Everything ended: nothing is left counted against anyone.
    expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
    expect(mod.ElysiumRpcBusyError).toBeDefined();
  });

  it('caps the bytes of answers held in memory, per client first, then for everyone', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_MAX_BUFFERED_BYTES: '250', ELYSIUM_RPC_MAX_BUFFERED_BYTES_PER_CLIENT: '150' });
    const answerOf = (bytes: number): Response => response(['{"result":"' + 'a'.repeat(bytes - 13) + '"}']);
    fetchMock.mockImplementation(async () => answerOf(100));

    // Client a holds one answer of 100 bytes (not read yet); a second one would pass its 150.
    const held = await service.forward(CALL, 1, 'a');
    expect(service.load.bufferedBytes).toBe(100);
    await expect(service.forward(CALL, 1, 'a')).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    expect(mockLog.warn).not.toHaveBeenCalled();
    // The refused answer left nothing behind.
    expect(service.load).toMatchObject({ inFlight: 1, bufferedBytes: 100 });

    // Another client fits; a third would pass the total of 250, and that is the proxy's shortage.
    const other = await service.forward(CALL, 1, 'b');
    await expect(service.forward(CALL, 1, 'c')).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    expect(mockLog.warn).toHaveBeenCalledWith('Elysium RPC proxy: answers held in memory at the ceiling', { maxBytes: 250 });

    // Released answers give their bytes back.
    held.release();
    expect(service.load.bufferedBytes).toBe(100);
    await expect(relay(service, CALL, 1, 'a')).resolves.toHaveLength(100);
    other.release();
    expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
  });

  it('delivers the answer as received and releases it when the client has it', async () => {
    const { service } = load();
    const upstream = '{"jsonrpc":"2.0", "id":7,\n "result":"0x1863d"}';
    fetchMock.mockResolvedValue(response([upstream.slice(0, 10), upstream.slice(10)]));
    const answer = await service.forward(CALL, 1, 'a');
    const res = fakeResponse();

    service.deliver(answer, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(upstream)) });
    expect(Buffer.concat(res.written).toString('utf8')).toBe(upstream);
    expect(res.ended).toBe(true);
    // Written, but the client has not taken it yet: still held.
    expect(service.load).toMatchObject({ inFlight: 1, bufferedBytes: Buffer.byteLength(upstream) });
    res.emit('finish');
    res.emit('close');
    expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
  });

  it('releases the answer of a client that went away, and cuts one that does not read', async () => {
    jest.useFakeTimers();
    try {
      const { service } = load();
      fetchMock.mockImplementation(async () => response(['{"result":1}']));

      const gone = fakeResponse();
      service.deliver(await service.forward(CALL, 1, 'a'), gone);
      gone.emit('close');
      expect(service.load.inFlight).toBe(0);

      const stuck = fakeResponse();
      service.deliver(await service.forward(CALL, 1, 'a'), stuck);
      jest.advanceTimersByTime(29_000);
      expect(stuck.destroyed).toBe(false);
      expect(service.load).toMatchObject({ inFlight: 1, bufferedBytes: 12 });
      jest.advanceTimersByTime(1_500);
      expect(stuck.destroyed).toBe(true);
      expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases at once an answer whose client already left: a closed response emits no further close', async () => {
    const { service } = load();
    fetchMock.mockImplementation(async () => response(['{"result":1}']));
    for (const state of [{ destroyed: true }, { writableEnded: true }, { socket: { destroyed: true } }]) {
      const res = Object.assign(fakeResponse(), state) as ReturnType<typeof fakeResponse>;
      service.deliver(await service.forward(CALL, 1, 'a'), res);
      // Nothing written to a response that is gone, and nothing left held.
      expect(res.written).toEqual([]);
      expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
    }
  });

  it('releases on the delivery timeout even when cutting the response emits nothing', async () => {
    jest.useFakeTimers();
    try {
      const { service } = load();
      fetchMock.mockImplementation(async () => response(['{"result":1}']));
      const silent = fakeResponse();
      silent.destroy = (() => silent) as typeof silent.destroy;
      service.deliver(await service.forward(CALL, 1, 'a'), silent);
      jest.advanceTimersByTime(30_001);
      expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('holds nothing for a client that leaves: before the call, while it waits for a slot, or at the node', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT: '1' });
    const pending: Array<{ resolve: (r: Response) => void; signal: AbortSignal }> = [];
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal as AbortSignal;
          pending.push({ resolve, signal });
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
        })
    );

    // Already gone: not even a slot.
    const before = new AbortController();
    before.abort();
    await expect(service.forward(CALL, 1, 'a', before.signal)).rejects.toBeInstanceOf(mod.ElysiumRpcClientGoneError);
    expect(fetchMock).not.toHaveBeenCalled();

    // One call at the node, a second waiting for the client's only slot.
    const atNode = new AbortController();
    const waiting = new AbortController();
    const first = service.forward(CALL, 1, 'a', atNode.signal);
    const second = service.forward(CALL, 1, 'a', waiting.signal);
    await turn();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The waiting one leaves, then the first one too: its call to the node is cut.
    waiting.abort();
    atNode.abort();
    await expect(first).rejects.toBeInstanceOf(mod.ElysiumRpcClientGoneError);
    expect(pending[0].signal.aborted).toBe(true);
    // The second got the slot the first freed, saw its client gone, and sent nothing.
    await expect(second).rejects.toBeInstanceOf(mod.ElysiumRpcClientGoneError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
    // Not logged as a failure of the node.
    expect(mockLog.warn).not.toHaveBeenCalledWith('Elysium RPC proxy transport error', expect.anything());
  });

  it('caps the weight of a minute across all clients, counting each call of a batch', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_GLOBAL_PER_MINUTE: '25' });
    let now = Date.parse('2026-11-10T10:00:20.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockImplementation(async () => response(['[]']));
    const batch = Array.from({ length: 10 }, () => CALL);

    await relay(service, batch, 10);
    await relay(service, batch, 10);
    await relay(service, CALL, 1);
    // 21 spent: a batch of 10 does not fit, 4 single calls still do.
    await expect(service.forward(batch, 10)).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    await expect(service.forward(batch, 10)).rejects.toMatchObject({ retryAfterS: 40 });
    for (let i = 0; i < 4; i++) await relay(service, CALL, 1);
    await expect(service.forward(CALL, 1)).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    // A refusal holds nothing.
    expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });

    // The minute rolls over.
    now = Date.parse('2026-11-10T10:01:00.000Z');
    await expect(relay(service, batch, 10)).resolves.toBe('[]');
  });

  it('never relays a non-JSON answer as JSON', async () => {
    const { service } = load();
    fetchMock.mockResolvedValue(response(['<html>Bad gateway</html>']));
    await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
    fetchMock.mockResolvedValue(response([]));
    await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
    // White space before the JSON is fine, across chunks too.
    fetchMock.mockResolvedValue(response([' \n', '\t[', '1]']));
    await expect(relay(service)).resolves.toBe(' \n\t[1]');
    expect(service.load).toEqual({ inFlight: 0, waiting: 0, bufferedBytes: 0, clients: 0 });
  });

  it('keeps the keyed URL out of every error and log line', async () => {
    const { service } = load({ ELYSIUM_RPC_MAX_RESPONSE_BYTES: '10' });
    const failures: Array<() => Promise<Response>> = [
      async () => {
        throw new TypeError(`fetch failed: ${KEYED_URL}`);
      },
      async () => response([`upstream said ${KEYED_URL}`], { status: 502 }),
      async () => response(['{"result":"' + 'a'.repeat(50) + '"}']),
      async () => response([`not json ${KEYED_URL}`.slice(0, 9)]),
    ];
    const messages: string[] = [];
    for (const failure of failures) {
      fetchMock.mockImplementationOnce(failure);
      await service.forward(CALL).catch((error: Error) => messages.push(`${error.name}: ${error.message}`));
    }
    expect(messages).toHaveLength(4);
    const logged = JSON.stringify([mockLog.warn.mock.calls, mockLog.error.mock.calls, mockLog.info.mock.calls]);
    expect(messages.join(' ')).not.toContain('SECRET-KEY-123');
    expect(logged).not.toContain('SECRET-KEY-123');
    expect(logged).not.toContain('rpc.example.test');
  });

  it('rewrites the node\'s error before it leaves: its own wording quoted the key', async () => {
    const { service } = load();
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: `Post "${KEYED_URL}": EOF`, stack: 'at /srv/rpc.js:1' } });
    fetchMock.mockResolvedValueOnce(response([raw.slice(0, 30), raw.slice(30)]));
    const answer = await service.forward(CALL, 1, 'c1');
    const text = textOf(answer);
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'Node error' } });
    expect(text).not.toContain('SECRET-KEY-123');
    // What is held and announced is the answer as it leaves, not as it came.
    expect(answer.bytes).toBe(Buffer.byteLength(text));
    expect(service.load.bufferedBytes).toBe(answer.bytes);
    answer.release();
    expect(service.load.bufferedBytes).toBe(0);
  });

  it('keeps a revert as the node said it, and a result byte for byte', async () => {
    const { service } = load();
    const revert = JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: 3, message: 'execution reverted: paused', data: '0x08c379a0' } });
    fetchMock.mockResolvedValueOnce(response([revert]));
    expect(JSON.parse(await relay(service))).toEqual(JSON.parse(revert));
    const result = '{"jsonrpc":"2.0","id":7,  "result":"0x1"}';
    fetchMock.mockResolvedValueOnce(response([result]));
    expect(await relay(service)).toBe(result);
  });

  it('does not relay a large answer that quotes the key, without reading it for errors', async () => {
    const { service } = load();
    const big = `{"jsonrpc":"2.0","id":7,"result":"0x${'ab'.repeat(200_000)}","debug":"${KEYED_URL}"}`;
    fetchMock.mockResolvedValueOnce(response([big.slice(0, 50_000), big.slice(50_000)]));
    await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
    expect(service.load.bufferedBytes).toBe(0);
    const fine = `{"jsonrpc":"2.0","id":7,"result":"0x${'ab'.repeat(200_000)}"}`;
    fetchMock.mockResolvedValueOnce(response([fine]));
    expect(await relay(service)).toBe(fine);
  });

  it('does not relay a small answer that quotes the key outside an error: in a result, in another field, in a body that is not the JSON it looks like', async () => {
    const { service } = load();
    for (const body of [
      `{"jsonrpc":"2.0","id":7,"result":"called ${KEYED_URL}"}`,
      `{"jsonrpc":"2.0","id":7,"result":"0x1","via":"SECRET-KEY-123"}`,
      `{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"boom"},"via":"rpc.example.test"`,
    ]) {
      fetchMock.mockResolvedValueOnce(response([body]));
      await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
    }
    expect(service.load.bufferedBytes).toBe(0);
  });

  it('rewrites the errors of a batch of 200 KB too', async () => {
    const { service } = load();
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: '0x' + 'ab'.repeat(100_000) },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'dial tcp 10.0.3.17:8545: connection refused', stack: 'at x' } },
    ]);
    fetchMock.mockResolvedValueOnce(response([batch]));
    const parsed = JSON.parse(await relay(service)) as Array<Record<string, unknown>>;
    expect(parsed[1]).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Node error' } });
    expect((parsed[0].result as string).length).toBe(200_002);
  });

  it('says so when no upstream is configured', async () => {
    const { service } = load();
    delete process.env.ELYSIUM_MAINNET_RPC_URL;
    expect(service.isConfigured()).toBe(false);
    await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
