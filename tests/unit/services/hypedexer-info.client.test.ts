/**
 * HypeDexer /info client: a 429 waits its Retry-After (5 s at most) and is
 * retried twice at most (the wait is 500 ms to 5 s, seconds or HTTP-date), the
 * calls in flight are capped and their starts paced process-wide, the
 * breaker opens on repeated failures, and the fallback to Hyperliquid is
 * logged once per outage.
 */
const warn = jest.fn();
const info = jest.fn();
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: (...a: unknown[]) => info(...a), warn: (...a: unknown[]) => warn(...a), error: jest.fn(), debug: jest.fn() },
}));

import {
  HypeDexerInfoClient,
  INFO_MAX_IN_FLIGHT,
  INFO_MAX_PER_SECOND,
  resetInfoPacing,
  resetInfoProxyOutages,
  sortLedgerAscending,
  viaInfoProxy,
} from '../../../src/clients/hypedexer/rest/info/info.client';
import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('HypeDexerInfoClient', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const client = HypeDexerInfoClient.getInstance();

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    warn.mockClear();
    info.mockClear();
    resetInfoProxyOutages();
    resetInfoPacing(0);
    // A fresh breaker for every test.
    (CircuitBreakerService as unknown as { instances: Map<string, unknown> }).instances.delete('hypedexer-info');
    (client as unknown as { circuitBreaker: CircuitBreakerService }).circuitBreaker =
      CircuitBreakerService.getInstance('hypedexer-info');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('posts the Hyperliquid body to /info on HypeDexer', async () => {
    fetchMock.mockImplementation(async () => reply(200, { states: [], gasAuction: {} }));
    await client.spotDeployState('0x0');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/info$/);
    expect(url).not.toMatch(/hyperliquid\.xyz/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ type: 'spotDeployState', user: '0x0' });
  });

  it('waits the Retry-After of a 429 and retries', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(reply(429, null, { 'retry-after': '2' }))
      .mockResolvedValueOnce(reply(200, [{ universe: [] }]));
    const call = client.allPerpMetas();
    await jest.advanceTimersByTimeAsync(1_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    await expect(call).resolves.toEqual([{ universe: [] }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps the wait at 5 s and the retries at 2', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async () => reply(429, null, { 'retry-after': '60' }));
    const call = client.allPerpMetas();
    const settled = call.then(
      () => 'resolved',
      (e: unknown) => e
    );
    await jest.advanceTimersByTimeAsync(4_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_100);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(settled).resolves.toMatchObject({ statusCode: 429 });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other error', async () => {
    fetchMock.mockImplementation(async () => reply(500));
    await expect(client.allPerpMetas()).rejects.toMatchObject({ statusCode: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps at most INFO_MAX_IN_FLIGHT calls in flight and serves the rest as slots free up', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve(reply(200, { assetPositions: [] }));
          });
        })
    );
    const calls = Array.from({ length: 15 }, (_, i) => client.clearinghouseState(`0x${i}`));
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(INFO_MAX_IN_FLIGHT);
    let done = 0;
    while (done < 15) {
      const batch = releases.splice(0);
      batch.forEach((release) => release());
      done += batch.length;
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(15);
    expect(peak).toBeLessThanOrEqual(INFO_MAX_IN_FLIGHT);
  });

  it('frees the slot while a 429 waits', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async () => reply(429, null, { 'retry-after': '1' }));
    const calls = Array.from({ length: INFO_MAX_IN_FLIGHT + 2 }, () =>
      client.allPerpMetas().catch(() => 'failed')
    );
    await jest.advanceTimersByTimeAsync(10);
    // Every call got its first attempt although the first six are all waiting out a 429.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(INFO_MAX_IN_FLIGHT + 2);
    await jest.advanceTimersByTimeAsync(20_000);
    await Promise.all(calls);
  });

  it('floors the Retry-After wait at 500 ms', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(reply(429, null, { 'retry-after': '0' })).mockResolvedValueOnce(reply(200, []));
    const call = client.allPerpMetas();
    await jest.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    await expect(call).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads a Retry-After given as an HTTP-date', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-10-30T12:00:00.000Z'));
    fetchMock
      .mockResolvedValueOnce(reply(429, null, { 'retry-after': 'Fri, 30 Oct 2026 12:00:03 GMT' }))
      .mockResolvedValueOnce(reply(200, []));
    const call = client.allPerpMetas();
    await jest.advanceTimersByTimeAsync(2_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    await expect(call).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits a second when the Retry-After is missing or unreadable', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(reply(429, null, { 'retry-after': 'soon' })).mockResolvedValueOnce(reply(200, []));
    const call = client.allPerpMetas();
    await jest.advanceTimersByTimeAsync(900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    await expect(call).resolves.toEqual([]);
  });

  describe('rate bound', () => {
    beforeEach(() => {
      resetInfoPacing();
    });

    it('starts at most INFO_MAX_PER_SECOND requests a second, whatever the callers', async () => {
      jest.useFakeTimers();
      fetchMock.mockImplementation(async () => reply(200, { assetPositions: [] }));
      // 4 "workers" back to back, instant answers: the worst case for the cap alone.
      const done: Promise<unknown>[] = [];
      for (let w = 0; w < 4; w += 1) {
        done.push(
          (async () => {
            for (let i = 0; i < 10; i += 1) await client.clearinghouseState(`0x${w}${i}`);
          })()
        );
      }
      await jest.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
      await jest.advanceTimersByTimeAsync(998);
      // Starts at t = 0, 100, ... 900 inside the first second.
      expect(fetchMock).toHaveBeenCalledTimes(INFO_MAX_PER_SECOND);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2 * INFO_MAX_PER_SECOND);
      await jest.advanceTimersByTimeAsync(10_000);
      await Promise.all(done);
      expect(fetchMock).toHaveBeenCalledTimes(40);
    });

    it('does not delay a lone call', async () => {
      fetchMock.mockImplementation(async () => reply(200, []));
      await client.allPerpMetas();
      await new Promise((r) => setTimeout(r, 120));
      const started = Date.now();
      await client.allPerpMetas();
      expect(Date.now() - started).toBeLessThan(50);
    });

    it('paces the retry of a 429 like any other start', async () => {
      jest.useFakeTimers();
      fetchMock.mockResolvedValueOnce(reply(429, null, { 'retry-after': '0' })).mockImplementation(async () => reply(200, []));
      const calls = Array.from({ length: 12 }, () => client.allPerpMetas());
      // The 12 first attempts start at 0, 100 ... 1100 ms; the retry (ready at 500 ms) takes the next turn.
      await jest.advanceTimersByTimeAsync(1_150);
      expect(fetchMock).toHaveBeenCalledTimes(12);
      await jest.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(13);
      await Promise.all(calls);
    });

    it('rejects, for the caller to fall back, when the turn is further away than the queue wait', async () => {
      fetchMock.mockImplementation(async () => reply(200, []));
      resetInfoPacing(20_000); // the first call takes the turn at once and reserves the next one 20 s ahead
      await client.allPerpMetas();
      await expect(client.allPerpMetas()).rejects.toThrow(/backlog/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('opens the breaker after repeated failures and then fails without calling HypeDexer', async () => {
    fetchMock.mockImplementation(async () => reply(500));
    for (let i = 0; i < 5; i++) await client.allPerpMetas().catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await expect(client.allPerpMetas()).rejects.toThrow('Circuit breaker is open');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('rejects a payload of the wrong shape', async () => {
    fetchMock.mockImplementation(async () => reply(200, { nope: true }));
    await expect(client.allPerpMetas()).rejects.toThrow('Unexpected allPerpMetas payload');
    await expect(client.spotClearinghouseState('0x1')).rejects.toThrow('Unexpected spotClearinghouseState payload');
  });

  it('returns ledger rows oldest first, ties by hash', async () => {
    const rows = [
      { time: 30, hash: '0xc', delta: { type: 'send' } },
      { time: 10, hash: '0xb', delta: { type: 'send' } },
      { time: 10, hash: '0xa', delta: { type: 'send' } },
      { time: 20, hash: '0xd', delta: { type: 'send' } },
    ];
    fetchMock.mockImplementation(async () => reply(200, rows));
    const out = await client.userNonFundingLedgerUpdates('0x5', 0);
    expect(out.map((r) => r.hash)).toEqual(['0xa', '0xb', '0xd', '0xc']);
    expect(sortLedgerAscending(rows)).toEqual(out);
    // The input is left alone.
    expect(rows[0].hash).toBe('0xc');
  });
});

describe('viaInfoProxy', () => {
  beforeEach(() => {
    warn.mockClear();
    info.mockClear();
    resetInfoProxyOutages();
  });

  it('uses the proxy and never the direct read when it answers', async () => {
    const direct = jest.fn(async () => 'hl');
    await expect(viaInfoProxy('t', async () => 'proxy', direct)).resolves.toBe('proxy');
    expect(direct).not.toHaveBeenCalled();
  });

  it('falls back to Hyperliquid on a proxy failure, logging once per outage', async () => {
    const direct = jest.fn(async () => 'hl');
    const failing = async (): Promise<string> => {
      throw new Error('down');
    };
    for (let i = 0; i < 4; i++) await expect(viaInfoProxy('t', failing, direct)).resolves.toBe('hl');
    expect(direct).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(1);

    // Back: one line, then a new outage logs again.
    await viaInfoProxy('t', async () => 'proxy', direct);
    expect(info).toHaveBeenCalledTimes(1);
    await viaInfoProxy('t', failing, direct);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the outages of different reads apart', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('down');
    };
    await viaInfoProxy('a', failing, async () => 'hl');
    await viaInfoProxy('b', failing, async () => 'hl');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('lets a failing direct read reject', async () => {
    await expect(
      viaInfoProxy(
        't',
        async () => {
          throw new Error('proxy');
        },
        async () => {
          throw new Error('direct');
        }
      )
    ).rejects.toThrow('direct');
  });
});
