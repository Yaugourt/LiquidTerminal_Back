/**
 * ElysiumRpcProxyService: the answer is relayed as text, never past the size
 * ceiling; the forwards in flight and the calls of a minute are capped across
 * all clients; no error or log line carries the keyed upstream URL.
 */
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

describe('ElysiumRpcProxyService', () => {
  const realFetch = global.fetch;
  const ENV_KEYS = [
    'ELYSIUM_RPC_MAX_RESPONSE_BYTES',
    'ELYSIUM_RPC_MAX_IN_FLIGHT',
    'ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT',
    'ELYSIUM_RPC_GLOBAL_PER_MINUTE',
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

    await expect(service.forward(CALL)).resolves.toBe(upstream);

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
    await expect(service.forward(CALL)).resolves.toBe(body);
  });

  it('caps the forwards in flight and frees the slot when one ends', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_MAX_IN_FLIGHT: '2' });
    const release: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => release.push(resolve)));

    const first = service.forward(CALL);
    const second = service.forward(CALL);
    const third = service.forward(CALL);
    await expect(third).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    await expect(third).rejects.toMatchObject({ retryAfterS: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    release[0](response(['{"result":1}']));
    await expect(first).resolves.toBe('{"result":1}');
    // A slot is free again, a failed forward frees its slot too.
    const fourth = service.forward(CALL);
    release[2](response(['nope'], { status: 500 }));
    await expect(fourth).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
    release[1](response(['{"result":2}']));
    await expect(second).resolves.toBe('{"result":2}');
    fetchMock.mockResolvedValue(response(['{"result":3}']));
    await expect(service.forward(CALL)).resolves.toBe('{"result":3}');
  });

  it('keeps one client from taking every slot: its own share fills first', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_MAX_IN_FLIGHT: '4', ELYSIUM_RPC_MAX_IN_FLIGHT_PER_CLIENT: '2' });
    const release: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => release.push(resolve)));

    const a1 = service.forward(CALL, 1, 'a');
    const a2 = service.forward(CALL, 1, 'a');
    // Client a holds its 2 slots: refused, and not logged as a shortage of the proxy.
    await expect(service.forward(CALL, 1, 'a')).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    expect(mockLog.warn).not.toHaveBeenCalled();
    // The others still get through, up to the total of 4.
    const b1 = service.forward(CALL, 1, 'b');
    const c1 = service.forward(CALL, 1, 'c');
    await expect(service.forward(CALL, 1, 'd')).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    expect(mockLog.warn).toHaveBeenCalledWith('Elysium RPC proxy: too many forwards in flight', { max: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // One of a's forwards ends: a gets one slot back, no more.
    release[0](response(['{"result":1}']));
    await a1;
    const a3 = service.forward(CALL, 1, 'a');
    await expect(service.forward(CALL, 1, 'a')).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    for (const r of release.slice(1)) r(response(['{"result":2}']));
    await Promise.all([a2, a3, b1, c1]);
    // Everything ended: nothing is left counted against anyone.
    const state = service as unknown as { inFlight: number; inFlightByClient: Map<string, number> };
    expect(state.inFlight).toBe(0);
    expect(state.inFlightByClient.size).toBe(0);
  });

  it('caps the calls of a minute across all clients, counting each call of a batch', async () => {
    const { service, mod } = load({ ELYSIUM_RPC_GLOBAL_PER_MINUTE: '25' });
    let now = Date.parse('2026-11-10T10:00:20.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockImplementation(async () => response(['[]']));
    const batch = Array.from({ length: 10 }, () => CALL);

    await service.forward(batch, 10);
    await service.forward(batch, 10);
    await service.forward(CALL, 1);
    // 21 spent: a batch of 10 does not fit, 4 single calls still do.
    await expect(service.forward(batch, 10)).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    await expect(service.forward(batch, 10)).rejects.toMatchObject({ retryAfterS: 40 });
    for (let i = 0; i < 4; i++) await service.forward(CALL, 1);
    await expect(service.forward(CALL, 1)).rejects.toBeInstanceOf(mod.ElysiumRpcBusyError);
    expect(fetchMock).toHaveBeenCalledTimes(7);

    // The minute rolls over.
    now = Date.parse('2026-11-10T10:01:00.000Z');
    await expect(service.forward(batch, 10)).resolves.toBe('[]');
  });

  it('never relays a non-JSON answer as JSON', async () => {
    const { service } = load();
    fetchMock.mockResolvedValue(response(['<html>Bad gateway</html>']));
    await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
    fetchMock.mockResolvedValue(response([]));
    await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_UPSTREAM');
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

  it('says so when no upstream is configured', async () => {
    const { service } = load();
    delete process.env.ELYSIUM_MAINNET_RPC_URL;
    expect(service.isConfigured()).toBe(false);
    await expect(service.forward(CALL)).rejects.toThrow('ELYSIUM_MAINNET_RPC_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
