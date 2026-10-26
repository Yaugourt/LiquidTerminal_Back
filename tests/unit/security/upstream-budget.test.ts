/**
 * Per-client budget of billed HypeDexer calls: the upstream-caller context
 * (open while the request is answered), the Redis counter with its in-memory
 * fallback, and the gate every HypeDexer REST call passes before it goes
 * upstream. Cache hits never get here; single-flight joiners, retries,
 * background work and the export (no context) never spend.
 */
import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';

// Small budgets so the tests do not make hundreds of calls. Read at module load.
process.env.HYPEDEXER_MISS_BUDGET_MINUTE = '5';
process.env.HYPEDEXER_MISS_BUDGET_HOUR = '8';

const mockRedis = {
  counters: new Map<string, number>(),
  ttls: new Map<string, number>(),
  fail: false,
  execCalls: 0,
};

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => true,
    getClient: () => {
      const ops: (() => [Error | null, unknown])[] = [];
      const pipeline = {
        incr: (key: string) => {
          ops.push(() => {
            const next = (mockRedis.counters.get(key) ?? 0) + 1;
            mockRedis.counters.set(key, next);
            return [null, next];
          });
          return pipeline;
        },
        expire: (key: string, seconds: number) => {
          ops.push(() => {
            mockRedis.ttls.set(key, seconds);
            return [null, 1];
          });
          return pipeline;
        },
        exec: async () => {
          mockRedis.execCalls += 1;
          if (mockRedis.fail) throw new Error("Stream isn't writeable");
          return ops.map((op) => op());
        },
      };
      return { pipeline: () => pipeline };
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { currentUpstreamCaller, runWithUpstreamCaller } from '../../../src/utils/request-context';
import {
  marketRateLimiter,
  passthroughRateLimiter,
  addressLookupRateLimiter,
  spendUpstreamBudget,
} from '../../../src/middleware/apiRateLimiter';
import { HypeDexerBaseClient } from '../../../src/clients/hypedexer/rest/shared/hypedexer-base.client';
import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';

class TestClient extends HypeDexerBaseClient {
  constructor() {
    super('http://hypedexer.test');
  }
  one(path: string): Promise<unknown> {
    return this.getUnwrapped<unknown>(path);
  }
  oneSingleAttempt(path: string): Promise<unknown> {
    return this.getSingleAttemptUnwrapped<unknown>(path);
  }
  direct(path: string): Promise<unknown> {
    return this.get<unknown>(path);
  }
  directPost(path: string): Promise<unknown> {
    return this.post<unknown>(path, { type: 'candleSnapshot' });
  }
}

/** A request/response pair whose response can finish or close. */
function exchange(ip: string): { req: Request; res: Response & EventEmitter } {
  const res = Object.assign(new EventEmitter(), {
    setHeader: () => res,
    status: () => res,
    json: () => res,
  }) as unknown as Response & EventEmitter;
  return { req: { ip, path: '/x', query: {} } as Request, res };
}

/** Runs `inside` with `ip` as the upstream caller, as the passthrough limiter does. */
function asCaller<T>(ip: string, inside: () => Promise<T>, res = exchange(ip).res): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithUpstreamCaller({ ip } as Request, res, (() => {
      inside().then(resolve, reject);
    }) as NextFunction);
  });
}

describe('upstream caller context', () => {
  it('is set inside the request and gone outside it', async () => {
    expect(currentUpstreamCaller()).toBeUndefined();
    const seen = await asCaller('1.2.3.4', async () => currentUpstreamCaller());
    expect(seen).toEqual({ ipKey: '1.2.3.4', open: true });
    expect(currentUpstreamCaller()).toBeUndefined();
  });

  it.each(['finish', 'close'])('closes when the response emits %s, for work that outlives it', async (event) => {
    const { res } = exchange('1.2.3.4');
    let lateTimer!: Promise<unknown>;
    await asCaller(
      '1.2.3.4',
      async () => {
        // Started inside the request, like a poller lazily created by its first visitor.
        lateTimer = new Promise((resolve) => setTimeout(() => resolve(currentUpstreamCaller()), 20));
        expect(currentUpstreamCaller()).toBeDefined();
      },
      res
    );
    res.emit(event);
    await expect(lateTimer).resolves.toBeUndefined();
  });

  it('keys IPv6 callers by their /64', async () => {
    const seen = await asCaller('2001:db8:1:2:aaaa:bbbb:cccc:dddd', async () => currentUpstreamCaller());
    expect(seen?.ipKey).toBe('2001:db8:1:2::/64');
  });
});

describe('limiters that set the context', () => {
  beforeEach(() => {
    mockRedis.counters.clear();
    mockRedis.fail = false;
  });

  it.each([
    ['passthrough', passthroughRateLimiter],
    ['address lookup', addressLookupRateLimiter],
  ])('%s runs an admitted request as the upstream caller', async (_name, limiter) => {
    const { req, res } = exchange('7.7.7.7');
    let seen: unknown = 'not called';
    await limiter(req, res, () => {
      seen = currentUpstreamCaller();
    });
    expect(seen).toEqual({ ipKey: '7.7.7.7', open: true });
  });

  it('keeps the context when Redis is down (fallback admits)', async () => {
    mockRedis.fail = true;
    const { req, res } = exchange('7.7.7.8');
    let seen: unknown = 'not called';
    await passthroughRateLimiter(req, res, () => {
      seen = currentUpstreamCaller();
    });
    expect(seen).toEqual({ ipKey: '7.7.7.8', open: true });
  });

  it('does not set it on the general limiter', async () => {
    const { req, res } = exchange('7.7.7.9');
    let seen: unknown = 'not called';
    await marketRateLimiter(req, res, () => {
      seen = currentUpstreamCaller();
    });
    expect(seen).toBeUndefined();
  });
});

describe('spendUpstreamBudget', () => {
  let now: number;

  beforeEach(() => {
    mockRedis.counters.clear();
    mockRedis.ttls.clear();
    mockRedis.fail = false;
    mockRedis.execCalls = 0;
    now = Date.parse('2026-10-26T10:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows the minute budget, then refuses until the minute rolls over', async () => {
    for (let i = 0; i < 5; i++) expect(await spendUpstreamBudget('10.0.0.1')).toEqual({ allowed: true });
    // Refused 20 s into the minute: 40 s left.
    now += 20_000;
    expect(await spendUpstreamBudget('10.0.0.1')).toEqual({ allowed: false, retryAfterS: 40 });
    // Another client is unaffected; the next minute starts afresh.
    expect(await spendUpstreamBudget('10.0.0.2')).toEqual({ allowed: true });
    now += 40_000;
    expect(await spendUpstreamBudget('10.0.0.1')).toEqual({ allowed: true });
  });

  it('refuses over the hour budget with the hour rollover, and expires its counters', async () => {
    // 8 an hour, 5 a minute: 4 + 4 across two minutes, the ninth is refused by the hour.
    for (let i = 0; i < 4; i++) await spendUpstreamBudget('10.0.0.3');
    now += 60_000;
    for (let i = 0; i < 4; i++) expect(await spendUpstreamBudget('10.0.0.3')).toEqual({ allowed: true });
    now += 60_000;
    // 10:02:00 into the hour: 3480 s left.
    expect(await spendUpstreamBudget('10.0.0.3')).toEqual({ allowed: false, retryAfterS: 3480 });
    for (const [key, ttl] of mockRedis.ttls) {
      expect(ttl).toBe(key.includes(':minute:') ? 120 : 7200);
      expect(key.startsWith('ratelimit:hdmiss:10.0.0.3:')).toBe(true);
    }
  });

  it('falls back to in-memory counters with the same limits when Redis fails', async () => {
    mockRedis.fail = true;
    for (let i = 0; i < 5; i++) expect(await spendUpstreamBudget('10.0.0.4')).toEqual({ allowed: true });
    expect(await spendUpstreamBudget('10.0.0.4')).toEqual({ allowed: false, retryAfterS: 60 });
    expect(await spendUpstreamBudget('10.0.0.5')).toEqual({ allowed: true });
    now += 61_000;
    expect(await spendUpstreamBudget('10.0.0.4')).toEqual({ allowed: true });
  });

  it('fallback also enforces the hour budget', async () => {
    mockRedis.fail = true;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) expect(await spendUpstreamBudget('10.0.0.6')).toEqual({ allowed: true });
      now += 61_000;
    }
    const refused = await spendUpstreamBudget('10.0.0.6');
    expect(refused).toEqual({ allowed: false, retryAfterS: expect.any(Number) });
    expect((refused as { retryAfterS: number }).retryAfterS).toBeGreaterThan(3000);
  });
});

describe('HypeDexer client gate', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: TestClient;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const spent = (): number =>
    [...mockRedis.counters].filter(([key]) => key.includes('hdmiss') && key.includes(':minute:')).reduce((n, [, c]) => n + c, 0);

  beforeEach(() => {
    mockRedis.counters.clear();
    mockRedis.fail = false;
    fetchMock = jest.fn(async () => json({ data: [1] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new TestClient();
    // Retries without the real backoff.
    (client as unknown as { delay: () => Promise<void> }).delay = () => Promise.resolve();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('spends nothing without a caller (pollers, timers, the export)', async () => {
    await client.one('/a');
    await client.oneSingleAttempt('/b');
    await client.direct('/c');
    await client.directPost('/info');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(spent()).toBe(0);
  });

  it('spends one unit per logical call, whichever entry point it takes', async () => {
    await asCaller('9.9.9.9', async () => {
      await client.one('/a');
      await client.oneSingleAttempt('/b');
      await client.direct('/c');
      await client.directPost('/info');
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(spent()).toBe(4);
  });

  it('does not spend again for a retry', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502)).mockResolvedValueOnce(json({ data: [1] }));
    await asCaller('9.9.9.9', () => client.one('/flaky'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spent()).toBe(1);
  });

  it('lets callers that join an in-flight request ride for free', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { release = () => resolve(json({ data: [1] })); })
    );
    const results = await (async () => {
      const first = asCaller('9.9.9.1', () => client.one('/same'));
      // Let the first call reach the network before the others arrive.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const joiners = ['9.9.9.2', '9.9.9.3'].map((ip) => asCaller(ip, () => client.one('/same')));
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      return Promise.all([first, ...joiners]);
    })();
    expect(results).toEqual([[1], [1], [1]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spent()).toBe(1);
    expect([...mockRedis.counters.keys()].some((key) => key.includes('9.9.9.2'))).toBe(false);
  });

  it('refuses a new call over the budget, with the retry delay, without calling upstream', async () => {
    for (let i = 0; i < 5; i++) await asCaller('9.9.9.9', () => client.one(`/k${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const refusal = await asCaller('9.9.9.9', () => client.one('/k5')).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UpstreamBudgetExceededError);
    expect(refusal).toMatchObject({ statusCode: 429, callerRefusal: true });
    expect((refusal as UpstreamBudgetExceededError).retryAfterS).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // The other entry points are gated alike, and another client is untouched.
    await expect(asCaller('9.9.9.9', () => client.direct('/x'))).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
    await expect(asCaller('9.9.9.9', () => client.directPost('/info'))).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
    await expect(asCaller('9.9.9.9', () => client.oneSingleAttempt('/y'))).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
    await expect(asCaller('9.9.8.8', () => client.one('/k5'))).resolves.toEqual([1]);
  });

  it('does not refuse a joiner with the client that started the call', async () => {
    for (let i = 0; i < 5; i++) await asCaller('9.9.9.9', () => client.one(`/k${i}`));
    fetchMock.mockClear();
    mockRedis.fail = false;
    // The over-budget client starts '/shared'; a fresh client joins within the same tick.
    const refused = asCaller('9.9.9.9', () => client.one('/shared'));
    const joiner = asCaller('9.9.7.7', () => client.one('/shared'));
    await expect(refused).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
    await expect(joiner).resolves.toEqual([1]);
  });

  it('stops charging once the request is over', async () => {
    const { res } = exchange('9.9.9.9');
    let later!: () => Promise<unknown>;
    await asCaller('9.9.9.9', async () => {
      later = () => new Promise((resolve) => setTimeout(() => resolve(client.one('/late')), 5));
      // Armed inside the request, fired after it.
      const armed = later();
      res.emit('finish');
      await armed;
    }, res);
    expect(spent()).toBe(0);
  });
});
