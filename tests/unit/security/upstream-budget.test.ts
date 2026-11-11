/**
 * Budget of what HypeDexer bills for a client's requests, in credits (it counted
 * calls until 2026-11-12). Decided once per request, on entry (peek, no
 * increment), then counted as it is known and never refused while counting: the upstream-caller context (open while the request is answered),
 * the Redis counters with their in-memory fallback, and the gate every
 * HypeDexer REST call passes. Cache hits never get here; single-flight
 * joiners, retries, background work and the export (no context) never count.
 * What a refusal does to the cache and to shared computations is in
 * upstream-budget-shared-work.test.ts.
 */
import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';

// Small budgets so the tests do not make hundreds of calls. Read at module load.
process.env.HYPEDEXER_CREDIT_BUDGET_MINUTE = '5';
process.env.HYPEDEXER_CREDIT_BUDGET_HOUR = '8';
// The common ceiling and the /48's share have their own cases below; here they stay out of the way.
process.env.HYPEDEXER_CREDIT_BUDGET_GLOBAL_MINUTE = '1000';
process.env.HYPEDEXER_CREDIT_RESERVE_MINUTE = '3';
process.env.HYPEDEXER_CREDIT_BUDGET_V6_SITE_FACTOR = '2';

const mockRedis = {
  counters: new Map<string, number>(),
  ttls: new Map<string, number>(),
  fail: false,
  healthy: true,
  execCalls: 0,
  mgetCalls: 0,
};

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    isHealthy: () => mockRedis.healthy,
    getClient: () => {
      const ops: (() => [Error | null, unknown])[] = [];
      const pipeline = {
        incr: (key: string) => pipeline.incrby(key, 1),
        incrby: (key: string, by: number) => {
          ops.push(() => {
            const next = (mockRedis.counters.get(key) ?? 0) + by;
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
      return {
        pipeline: () => pipeline,
        mget: async (...keys: string[]) => {
          mockRedis.mgetCalls += 1;
          if (mockRedis.fail) throw new Error("Stream isn't writeable");
          return keys.map((key) => (mockRedis.counters.has(key) ? String(mockRedis.counters.get(key)) : null));
        },
      };
    },
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  ABORT_GRACE_MS,
  currentUpstreamCaller,
  runWithUpstreamCaller,
  type UpstreamBudgetState,
} from '../../../src/utils/request-context';
import {
  marketRateLimiter,
  passthroughRateLimiter,
  addressLookupRateLimiter,
  peekUpstreamBudget,
  countUpstreamCredits,
} from '../../../src/middleware/apiRateLimiter';
import { HypeDexerBaseClient } from '../../../src/clients/hypedexer/rest/shared/hypedexer-base.client';
import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';
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

/** A client wrapped in a circuit breaker, as nearly every HypeDexer client is. */
class BreakerClient extends TestClient {
  private readonly circuitBreaker = CircuitBreakerService.getInstance('upstream-budget-test');
  guarded(path: string): Promise<unknown> {
    return this.circuitBreaker.execute(() => this.getUnwrapped<unknown>(path));
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

/** One credit billed to `ipKey` (an IPv4 client: no /48). */
const countUpstreamCall = (ipKey: string): void => countUpstreamCredits({ ipKey }, 1);

const WITHIN: UpstreamBudgetState = { exhausted: false, retryAfterS: 0 };
const EXHAUSTED: UpstreamBudgetState = { exhausted: true, retryAfterS: 17 };

/** Runs `inside` with `ip` as the upstream caller, as the passthrough limiter does (peek stubbed). */
function asCaller<T>(
  ip: string,
  inside: () => Promise<T>,
  options: { state?: UpstreamBudgetState; res?: Response } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void runWithUpstreamCaller(
      { ip } as Request,
      options.res ?? exchange(ip).res,
      (() => {
        inside().then(resolve, reject);
      }) as NextFunction,
      async () => options.state ?? WITHIN
    );
  });
}

const resetRedis = (): void => {
  mockRedis.counters.clear();
  mockRedis.ttls.clear();
  mockRedis.fail = false;
  mockRedis.healthy = true;
  mockRedis.execCalls = 0;
  mockRedis.mgetCalls = 0;
};

/** Minute-window count of one client in the fake Redis. */
const spentBy = (ipKey: string): number =>
  [...mockRedis.counters]
    .filter(([key]) => key.startsWith(`ratelimit:hdcr:${ipKey}:minute:`))
    .reduce((n, [, c]) => n + c, 0);
/** Credits counted this minute for all clients together (the common counter). */
const spent = (): number => spentBy('all');
/** Lets the counting pipelines (not awaited by the calls) land. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('upstream caller context', () => {
  it('is set inside the request with the verdict peeked on entry, and gone outside it', async () => {
    expect(currentUpstreamCaller()).toBeUndefined();
    const within = await asCaller('1.2.3.4', async () => currentUpstreamCaller());
    expect(within).toEqual({ ipKey: '1.2.3.4', open: true, exhausted: false, retryAfterS: 0 });
    const over = await asCaller('1.2.3.5', async () => currentUpstreamCaller(), { state: EXHAUSTED });
    expect(over).toEqual({ ipKey: '1.2.3.5', open: true, exhausted: true, retryAfterS: 17 });
    expect(currentUpstreamCaller()).toBeUndefined();
  });

  it('closes when the response finishes, for work that outlives it', async () => {
    const event = 'finish';
    const { res } = exchange('1.2.3.4');
    let lateTimer!: Promise<unknown>;
    await asCaller(
      '1.2.3.4',
      async () => {
        // Started inside the request, like a poller lazily created by its first visitor.
        lateTimer = new Promise((resolve) => setTimeout(() => resolve(currentUpstreamCaller()), 20));
        expect(currentUpstreamCaller()).toBeDefined();
      },
      { res }
    );
    res.emit(event);
    await expect(lateTimer).resolves.toBeUndefined();
  });

  it('keys IPv6 callers by their /64, with the /48 it sits in; an IPv4 caller has none', async () => {
    const seen = await asCaller('2001:db8:1:2:aaaa:bbbb:cccc:dddd', async () => currentUpstreamCaller());
    expect(seen?.ipKey).toBe('2001:db8:1:2::/64');
    expect(seen?.siteKey).toBe('2001:db8:1::/48');
    const v4 = await asCaller('1.2.3.4', async () => currentUpstreamCaller());
    expect(v4 && 'siteKey' in v4).toBe(false);
  });

  it('peeks once when two limiters of a route stack', async () => {
    const peek = jest.fn(async () => WITHIN);
    const { req, res } = exchange('1.2.3.4');
    const inner = jest.fn();
    await runWithUpstreamCaller(req, res, (() => {
      void runWithUpstreamCaller(req, res, inner as unknown as NextFunction, peek);
    }) as NextFunction, peek);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledTimes(1);
  });

  it('never blocks a visitor because the budget could not be read', async () => {
    const seen = await new Promise<unknown>((resolve) => {
      const { req, res } = exchange('1.2.3.4');
      void runWithUpstreamCaller(req, res, (() => resolve(currentUpstreamCaller())) as NextFunction, async () => {
        throw new Error('peek exploded');
      });
    });
    expect(seen).toMatchObject({ exhausted: false });
  });
});

describe('a request whose client drops the connection', () => {
  const realFetch = global.fetch;
  let client: TestClient;

  beforeEach(() => {
    resetRedis();
    // setImmediate stays real: settle() waits on it for the counting pipelines.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ data: [1] }), { status: 200, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch;
    client = new TestClient();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  /** Runs `inside` as the caller of a request that the client drops right after entry (a 'close' with no 'finish'). */
  const abortedCaller = <T>(ip: string, inside: () => Promise<T>, state: UpstreamBudgetState): Promise<T> => {
    const { res } = exchange(ip);
    return asCaller(
      ip,
      async () => {
        res.emit('close');
        return inside();
      },
      { res, state }
    );
  };

  it('is still refused at a gate reached within the grace', async () => {
    const refusal = await abortedCaller(
      '8.8.8.8',
      async () => {
        jest.advanceTimersByTime(ABORT_GRACE_MS - 1);
        return client.one('/cold').catch((error: unknown) => error);
      },
      EXHAUSTED
    );
    expect(refusal).toBeInstanceOf(UpstreamBudgetExceededError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is still counted at a gate reached within the grace, when it entered within budget', async () => {
    await abortedCaller(
      '8.8.8.9',
      async () => {
        jest.advanceTimersByTime(ABORT_GRACE_MS - 1);
        await client.one('/cold');
      },
      WITHIN
    );
    await settle();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(spentBy('8.8.8.9')).toBe(2);
  });

  it('is no caller once the grace is over: a timer it started is released', async () => {
    const seen = await abortedCaller(
      '8.8.8.8',
      async () => {
        expect(currentUpstreamCaller()).toBeDefined();
        jest.advanceTimersByTime(ABORT_GRACE_MS);
        const caller = currentUpstreamCaller();
        // Nothing is refused or counted any more.
        await client.one('/late');
        return caller;
      },
      EXHAUSTED
    );
    await settle();
    expect(seen).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(spent()).toBe(0);
  });

  it('closes at once on a normal finish, and the finish after a close cancels the grace', async () => {
    const { res } = exchange('8.8.8.7');
    const seen = await asCaller(
      '8.8.8.7',
      async () => {
        res.emit('finish');
        return currentUpstreamCaller();
      },
      { res }
    );
    expect(seen).toBeUndefined();

    // A usual response emits 'close' after 'finish': that must not reopen anything or leave a timer.
    res.emit('close');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('starts the grace when the socket was already destroyed before the listeners were attached', async () => {
    const { res } = exchange('8.8.8.6');
    const req = { ip: '8.8.8.6', path: '/x', query: {}, socket: { destroyed: true } } as unknown as Request;
    const states = await new Promise<[unknown, unknown]>((resolve) => {
      void runWithUpstreamCaller(
        req,
        res,
        (() => {
          const within = { ...currentUpstreamCaller() };
          jest.advanceTimersByTime(ABORT_GRACE_MS);
          resolve([within, currentUpstreamCaller()]);
        }) as NextFunction,
        async () => EXHAUSTED
      );
    });
    expect(states[0]).toMatchObject({ exhausted: true, open: true });
    expect(states[1]).toBeUndefined();
  });

  it('closes at once when the response had already finished before the listeners were attached', async () => {
    const { res } = exchange('8.8.8.5');
    Object.assign(res, { writableFinished: true });
    const seen = await asCaller('8.8.8.5', async () => currentUpstreamCaller(), { res });
    expect(seen).toBeUndefined();
  });
});

describe('limiters that set the context', () => {
  beforeEach(resetRedis);

  it.each([
    ['passthrough', passthroughRateLimiter],
    ['address lookup', addressLookupRateLimiter],
  ])('%s runs an admitted request as the upstream caller, within budget', async (_name, limiter) => {
    const { req, res } = exchange('7.7.7.7');
    let seen: unknown = 'not called';
    await limiter(req, res, () => {
      seen = currentUpstreamCaller();
    });
    expect(seen).toEqual({ ipKey: '7.7.7.7', open: true, exhausted: false, retryAfterS: 0 });
  });

  it('marks the request exhausted on entry when the client is at its limit, and still admits it', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    mockRedis.counters.set(`ratelimit:hdcr:7.7.7.6:minute:${Math.floor(nowS / 60)}`, 5);
    const { req, res } = exchange('7.7.7.6');
    let seen: unknown = 'not called';
    await passthroughRateLimiter(req, res, () => {
      seen = currentUpstreamCaller();
    });
    expect(seen).toMatchObject({ ipKey: '7.7.7.6', open: true, exhausted: true });
    expect((seen as { retryAfterS: number }).retryAfterS).toBeGreaterThanOrEqual(1);
  });

  it('keeps the context when Redis is down (fallback admits)', async () => {
    mockRedis.fail = true;
    const { req, res } = exchange('7.7.7.8');
    let seen: unknown = 'not called';
    await passthroughRateLimiter(req, res, () => {
      seen = currentUpstreamCaller();
    });
    expect(seen).toMatchObject({ ipKey: '7.7.7.8', open: true, exhausted: false });
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

describe('peekUpstreamBudget and countUpstreamCall', () => {
  let now: number;

  beforeEach(() => {
    resetRedis();
    now = Date.parse('2026-10-26T10:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads the counters without incrementing them', async () => {
    countUpstreamCall('10.0.0.1');
    await settle();
    const before = new Map(mockRedis.counters);
    const execBefore = mockRedis.execCalls;
    for (let i = 0; i < 3; i++) expect(await peekUpstreamBudget('10.0.0.1')).toEqual({ exhausted: false, retryAfterS: 0 });
    expect(mockRedis.counters).toEqual(before);
    expect(mockRedis.execCalls).toBe(execBefore);
    expect(mockRedis.mgetCalls).toBe(3);
  });

  it('counts with the limiter key scheme: INCRBY + EXPIRE of the minute and hour windows, for the client and for everyone', async () => {
    countUpstreamCall('10.0.0.1');
    await settle();
    expect(spentBy('10.0.0.1')).toBe(1);
    expect(spent()).toBe(1);
    expect(mockRedis.execCalls).toBe(1);
    expect(mockRedis.counters.size).toBe(4);
    for (const [key, ttl] of mockRedis.ttls) {
      expect(key.startsWith('ratelimit:hdcr:10.0.0.1:') || key.startsWith('ratelimit:hdcr:all:')).toBe(true);
      expect(ttl).toBe(key.includes(':minute:') ? 120 : 7200);
    }
  });

  it('counts what was billed, rounded up, and nothing for a cost that is not one', async () => {
    countUpstreamCredits({ ipKey: '10.0.0.11' }, 2);
    countUpstreamCredits({ ipKey: '10.0.0.11' }, 0.4);
    for (const none of [0, -3, NaN, Infinity]) countUpstreamCredits({ ipKey: '10.0.0.11' }, none);
    await settle();
    expect(spentBy('10.0.0.11')).toBe(3);
  });

  it('is exhausted at the minute limit, until the minute rolls over', async () => {
    for (let i = 0; i < 4; i++) countUpstreamCall('10.0.0.1');
    await settle();
    expect(await peekUpstreamBudget('10.0.0.1')).toEqual({ exhausted: false, retryAfterS: 0 });
    countUpstreamCall('10.0.0.1');
    await settle();
    // 20 s into the minute: 40 s left.
    now += 20_000;
    expect(await peekUpstreamBudget('10.0.0.1')).toEqual({ exhausted: true, retryAfterS: 40 });
    // Another client is untouched; the next minute starts afresh.
    expect(await peekUpstreamBudget('10.0.0.2')).toEqual({ exhausted: false, retryAfterS: 0 });
    now += 40_000;
    expect(await peekUpstreamBudget('10.0.0.1')).toEqual({ exhausted: false, retryAfterS: 0 });
  });

  it('is exhausted at the hour limit with the hour rollover', async () => {
    // 8 an hour, 5 a minute: 4 + 4 across two minutes.
    for (let i = 0; i < 4; i++) countUpstreamCall('10.0.0.3');
    await settle();
    now += 60_000;
    for (let i = 0; i < 4; i++) countUpstreamCall('10.0.0.3');
    await settle();
    now += 60_000;
    // 10:02:00 into the hour: 3480 s left, but a refused client is told to come back within the minute.
    expect(await peekUpstreamBudget('10.0.0.3')).toEqual({ exhausted: true, retryAfterS: 60 });
  });

  it('keeps asking the client back every minute until the hour rolls over, then lets it through', async () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) countUpstreamCall('10.0.0.9');
      await settle();
      now += 60_000;
    }
    // Refused for the rest of the hour, whatever the time left, never told to wait longer than 60 s.
    for (let minute = 0; minute < 58; minute++) {
      const state = await peekUpstreamBudget('10.0.0.9');
      expect(state.exhausted).toBe(true);
      expect(state.retryAfterS).toBeLessThanOrEqual(60);
      now += 60_000;
    }
    expect(await peekUpstreamBudget('10.0.0.9')).toEqual({ exhausted: false, retryAfterS: 0 });
  });

  it('tells an hour-limited client the time left in the hour when under a minute remains', async () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) countUpstreamCall('10.0.0.10');
      await settle();
      now += 60_000;
    }
    // 10:59:30: 30 s left in the hour.
    now = Date.parse('2026-10-26T10:59:30.000Z');
    expect(await peekUpstreamBudget('10.0.0.10')).toEqual({ exhausted: true, retryAfterS: 30 });
  });

  it('never refuses what it counts: counting past the limit just keeps counting', async () => {
    for (let i = 0; i < 12; i++) countUpstreamCall('10.0.0.4');
    await settle();
    expect(spentBy('10.0.0.4')).toBe(12);
  });

  it('falls back to in-memory counters, with the same limits, when Redis fails', async () => {
    mockRedis.fail = true;
    for (let i = 0; i < 4; i++) countUpstreamCall('10.0.0.5');
    await settle();
    expect(await peekUpstreamBudget('10.0.0.5')).toEqual({ exhausted: false, retryAfterS: 0 });
    countUpstreamCall('10.0.0.5');
    await settle();
    expect(await peekUpstreamBudget('10.0.0.5')).toEqual({ exhausted: true, retryAfterS: 60 });
    expect(await peekUpstreamBudget('10.0.0.6')).toEqual({ exhausted: false, retryAfterS: 0 });
    now += 61_000;
    expect(await peekUpstreamBudget('10.0.0.5')).toEqual({ exhausted: false, retryAfterS: 0 });
    expect(spent()).toBe(0);
  });

  /**
   * Nothing bounded what all clients spent together: a scan spread over a thousand addresses,
   * each within its own budget, spent a thousand budgets. (Here: 1,000 credits a minute for
   * everyone, a reserve of 3 per client.)
   */
  describe('the ceiling common to all clients', () => {
    const everyone = (credits: number): void => {
      mockRedis.counters.set(`ratelimit:hdcr:all:minute:${Math.floor(now / 60_000)}`, credits);
    };

    it('past it, a client that has spent its reserve this minute is held back; one that has not goes on', async () => {
      for (let i = 0; i < 3; i++) countUpstreamCall('10.1.0.1');
      countUpstreamCall('10.1.0.2');
      await settle();
      everyone(999);
      expect(await peekUpstreamBudget('10.1.0.1')).toEqual({ exhausted: false, retryAfterS: 0 });
      everyone(1000);
      now += 15_000;
      expect(await peekUpstreamBudget('10.1.0.1')).toEqual({ exhausted: true, retryAfterS: 45 });
      // An ordinary visitor, and one who has not asked for anything yet, are not refused for the flood of others.
      expect(await peekUpstreamBudget('10.1.0.2')).toEqual({ exhausted: false, retryAfterS: 0 });
      expect(await peekUpstreamBudget('10.1.0.3')).toEqual({ exhausted: false, retryAfterS: 0 });
    });

    it('past twice it, nobody starts new billed work until the minute rolls over', async () => {
      everyone(2000);
      expect(await peekUpstreamBudget('10.1.0.4')).toEqual({ exhausted: true, retryAfterS: 60 });
      now += 60_000;
      expect(await peekUpstreamBudget('10.1.0.4')).toEqual({ exhausted: false, retryAfterS: 0 });
    });

    it('holds with the in-memory counters too, when Redis cannot answer', async () => {
      mockRedis.fail = true;
      // 400 clients spend 5 credits each: 2,000 in all, each within its own budget.
      for (let c = 0; c < 400; c++) countUpstreamCredits({ ipKey: `10.2.${c >> 8}.${c & 255}` }, 5);
      await settle();
      expect(await peekUpstreamBudget('10.3.0.1')).toMatchObject({ exhausted: true });
    });
  });

  /** A /64 is one subnet; whoever holds a /48 had 65,536 budgets. (Here: a /48 gets 2 clients' worth.) */
  describe('the /48 of an IPv6 client', () => {
    const site = '2001:db8:42::/48';
    const subnet = (n: number): string => `2001:db8:42:${n.toString(16)}::/64`;

    it('is counted too, in the same round trip, and holds its subnets to a few clients\' worth', async () => {
      // Four subnets of one /48 spend 3 credits each: each is under its own 5, the /48 is past its 10.
      for (let n = 0; n < 4; n++) countUpstreamCredits({ ipKey: subnet(n), siteKey: site }, 3);
      await settle();
      expect(mockRedis.execCalls).toBe(4);
      expect(spentBy(`site:${site}`)).toBe(12);
      expect(await peekUpstreamBudget(subnet(0), site)).toMatchObject({ exhausted: true });
      // A subnet of the same /48 that has spent nothing is held with it.
      expect(await peekUpstreamBudget(subnet(9), site)).toMatchObject({ exhausted: true });
      // Another /48, and an IPv4 client, are untouched.
      expect(await peekUpstreamBudget('2001:db8:43:1::/64', '2001:db8:43::/48')).toEqual({ exhausted: false, retryAfterS: 0 });
      expect(await peekUpstreamBudget('10.4.0.1')).toEqual({ exhausted: false, retryAfterS: 0 });
    });

    it('shares one reserve between its subnets once the common ceiling is passed', async () => {
      for (let n = 0; n < 3; n++) countUpstreamCredits({ ipKey: subnet(n), siteKey: site }, 1);
      await settle();
      mockRedis.counters.set(`ratelimit:hdcr:all:minute:${Math.floor(now / 60_000)}`, 1000);
      // Each subnet has spent 1 credit, the /48 has spent the reserve of 3.
      expect(await peekUpstreamBudget(subnet(7), site)).toMatchObject({ exhausted: true });
    });
  });

  it('uses the in-memory counters at once when the Redis circuit is open', async () => {
    mockRedis.healthy = false;
    for (let i = 0; i < 5; i++) countUpstreamCall('10.0.0.7');
    // No Redis round trip, no waiting: counted synchronously.
    expect(mockRedis.execCalls).toBe(0);
    expect(await peekUpstreamBudget('10.0.0.7')).toMatchObject({ exhausted: true });
    expect(mockRedis.mgetCalls).toBe(0);
  });

  it('fallback also enforces the hour limit', async () => {
    mockRedis.fail = true;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) countUpstreamCall('10.0.0.8');
      await settle();
      now += 61_000;
    }
    const state = await peekUpstreamBudget('10.0.0.8');
    expect(state.exhausted).toBe(true);
    expect(state.retryAfterS).toBe(60);
  });
});

describe('HypeDexer client gate', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: TestClient;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    resetRedis();
    fetchMock = jest.fn(async () => json({ data: [1] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new TestClient();
    // Retries without the real backoff.
    (client as unknown as { delay: () => Promise<void> }).delay = () => Promise.resolve();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('counts nothing without a caller (pollers, timers, the export)', async () => {
    await client.one('/a');
    await client.oneSingleAttempt('/b');
    await client.direct('/c');
    await client.directPost('/info');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(spent()).toBe(0);
  });

  it('counts one unit per logical call, whichever entry point it takes', async () => {
    await asCaller('9.9.9.9', async () => {
      await client.one('/a');
      await client.oneSingleAttempt('/b');
      await client.direct('/c');
      await client.directPost('/info');
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The price any call has when it starts (2 credits); these answers say nothing more.
    expect(spent()).toBe(8);
  });

  it('counts what the answer says the call cost: 2 credits when it starts, the rest when it is billed', async () => {
    const billed = (credits: string): Response =>
      new Response(JSON.stringify({ data: [1] }), { status: 200, headers: { 'content-type': 'application/json', 'x-credit-cost': credits } });
    fetchMock
      .mockResolvedValueOnce(billed('12')) // 100 rows
      .mockResolvedValueOnce(billed('102')) // 1,000 rows
      .mockResolvedValueOnce(billed('2')) // an empty page
      .mockResolvedValueOnce(billed('n/a'));
    await asCaller('9.9.9.9', async () => {
      await client.one('/hundred');
      await client.one('/thousand');
      await client.one('/empty');
      await client.one('/unpriced');
    });
    await settle();
    expect(spentBy('9.9.9.9')).toBe(12 + 102 + 2 + 2);
    expect(spent()).toBe(118);
  });

  it('a call that fails is not billed, and keeps the price it started with', async () => {
    fetchMock.mockResolvedValue(json({}, 500));
    await expect(asCaller('9.9.9.9', () => client.oneSingleAttempt('/down'))).rejects.toThrow();
    await settle();
    expect(spentBy('9.9.9.9')).toBe(2);
  });

  it('does not count a retry again', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502)).mockResolvedValueOnce(json({ data: [1] }));
    await asCaller('9.9.9.9', () => client.one('/flaky'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spent()).toBe(2);
  });

  it('never counts a caller that joins an in-flight call, and never refuses one', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { release = () => resolve(json({ data: [1] })); })
    );
    const first = asCaller('9.9.9.1', () => client.one('/same'));
    // Let the first call reach the network before the others arrive.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const joiners = [
      asCaller('9.9.9.2', () => client.one('/same')),
      // Over budget on entry: joining is still free.
      asCaller('9.9.9.3', () => client.one('/same'), { state: EXHAUSTED }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await expect(Promise.all([first, ...joiners])).resolves.toEqual([[1], [1], [1]]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spentBy('9.9.9.1')).toBe(2);
    expect(spentBy('9.9.9.2')).toBe(0);
    expect(spentBy('9.9.9.3')).toBe(0);
  });

  it('never refuses a caller that was within budget on entry, even when its calls pass the limit', async () => {
    // 5 a minute; this one request makes 12 calls, all of them go upstream and are counted.
    await asCaller('9.9.9.9', async () => {
      for (let i = 0; i < 12; i++) await client.one(`/fan${i}`);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(spentBy('9.9.9.9')).toBe(24);
    // Its next request finds the counter where it ended.
    expect(await peekUpstreamBudget('9.9.9.9')).toMatchObject({ exhausted: true });
  });

  it('refuses an over-budget caller before the call starts, with its retry delay, and leaves nothing in flight', async () => {
    const refusal = await asCaller('9.9.9.9', () => client.one('/k'), { state: EXHAUSTED }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UpstreamBudgetExceededError);
    expect(refusal).toMatchObject({ statusCode: 429, callerRefusal: true, retryAfterS: 17 });
    expect(fetchMock).not.toHaveBeenCalled();
    await settle();
    expect(spent()).toBe(0);

    // The other entry points are gated alike.
    for (const call of [
      () => client.direct('/x'),
      () => client.directPost('/info'),
      () => client.oneSingleAttempt('/y'),
    ]) {
      await expect(asCaller('9.9.9.9', call, { state: EXHAUSTED })).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a concurrent caller from another IP start its own call after a refusal', async () => {
    // Same endpoint, same tick: the refused call registered nothing, so the other one is not a joiner of it.
    const refused = asCaller('9.9.9.9', () => client.one('/shared'), { state: EXHAUSTED });
    const other = asCaller('9.9.7.7', () => client.one('/shared'));
    await expect(refused).rejects.toBeInstanceOf(UpstreamBudgetExceededError);
    await expect(other).resolves.toEqual([1]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spentBy('9.9.7.7')).toBe(2);
    expect(spentBy('9.9.9.9')).toBe(0);
  });

  it('stops counting once the request is over', async () => {
    const { res } = exchange('9.9.9.9');
    await asCaller(
      '9.9.9.9',
      async () => {
        // Armed inside the request, fired after it.
        const armed = new Promise((resolve) => setTimeout(() => resolve(client.one('/late')), 5));
        res.emit('finish');
        await armed;
      },
      { res }
    );
    await settle();
    expect(spent()).toBe(0);
  });

  describe('through a circuit breaker', () => {
    let guarded: BreakerClient;

    beforeEach(() => {
      guarded = new BreakerClient();
    });

    it('leaves the breaker closed after many refusals, and a call for another IP still reaches the upstream', async () => {
      for (let i = 0; i < 10; i++) {
        await expect(asCaller('9.9.9.9', () => guarded.guarded(`/k${i}`), { state: EXHAUSTED })).rejects.toBeInstanceOf(
          UpstreamBudgetExceededError
        );
      }
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(asCaller('9.9.8.8', () => guarded.guarded('/k0'))).resolves.toEqual([1]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
