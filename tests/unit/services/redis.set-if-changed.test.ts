/**
 * Pollers rewrite big blobs on a timer that mostly come back unchanged (the
 * vault lists: 8.8 MB every 30 s, identical for minutes). setIfChanged writes
 * a value only when it changed, checks that the key is still there otherwise,
 * and writes anyway after 10 min or a reconnection.
 *
 * The AOF guard turns Redis's AOF off on every connection (the Railway image
 * turns it back on at each start) and refreshes the unused file with
 * BGREWRITEAOF, so a restart reloads recent data.
 */
type Handler = (...args: unknown[]) => void;
interface FakeClient {
  handlers: Record<string, Handler[]>;
  set: jest.Mock;
  exists: jest.Mock;
  expire: jest.Mock;
  config: jest.Mock;
  bgrewriteaof: jest.Mock;
}

jest.mock('ioredis', () => {
  const make = (): Record<string, unknown> => {
    const handlers: Record<string, Handler[]> = {};
    return {
      handlers,
      status: 'ready',
      on: jest.fn((event: string, handler: Handler) => {
        (handlers[event] ??= []).push(handler);
      }),
      once: jest.fn(),
      removeListener: jest.fn(),
      setMaxListeners: jest.fn(),
      ping: jest.fn(async () => 'PONG'),
      disconnect: jest.fn(),
      connect: jest.fn(async () => undefined),
      set: jest.fn(async () => 'OK'),
      exists: jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
      config: jest.fn(async () => ['appendonly', 'no']),
      bgrewriteaof: jest.fn(async () => 'Background append only file rewriting started'),
    };
  };
  return { __esModule: true, default: jest.fn(make) };
});
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** A fresh copy of the module (its key memory and guard state are module-level). */
function load(): { service: typeof import('../../../src/core/redis.service').redisService; client: FakeClient; ready: () => void } {
  let loaded!: typeof import('../../../src/core/redis.service');
  let Redis!: jest.Mock;
  jest.isolateModules(() => {
    Redis = jest.requireMock('ioredis').default as jest.Mock;
    Redis.mockClear();
    loaded = require('../../../src/core/redis.service');
  });
  // The module builds the subscriber first, then the command client.
  const client = Redis.mock.results[1].value as FakeClient;
  const ready = (): void => {
    for (const handler of client.handlers.ready ?? []) handler();
  };
  return { service: loaded.redisService, client, ready };
}

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  jest.useRealTimers();
});

describe('RedisService.setIfChanged', () => {
  it('writes a new value, then only checks the key while the value stays the same', async () => {
    const { service, client } = load();

    expect(await service.setIfChanged('vaults:list', 'A')).toBe(true);
    expect(client.set).toHaveBeenCalledWith('vaults:list', 'A');

    client.set.mockClear();
    expect(await service.setIfChanged('vaults:list', 'A')).toBe(false);
    expect(client.set).not.toHaveBeenCalled();
    expect(client.exists).toHaveBeenCalledWith('vaults:list');

    expect(await service.setIfChanged('vaults:list', 'B')).toBe(true);
    expect(client.set).toHaveBeenCalledWith('vaults:list', 'B');
  });

  it('writes the unchanged value again when the key is gone', async () => {
    const { service, client } = load();
    await service.setIfChanged('k', 'A');
    client.set.mockClear();
    client.exists.mockResolvedValueOnce(0);

    expect(await service.setIfChanged('k', 'A')).toBe(true);
    expect(client.set).toHaveBeenCalledWith('k', 'A');
  });

  it('renews the TTL of an unchanged value instead of writing it, and writes when the key expired', async () => {
    const { service, client } = load();
    await service.setIfChanged('builders:all', 'A', 60);
    expect(client.set).toHaveBeenCalledWith('builders:all', 'A', 'EX', 60);
    client.set.mockClear();

    expect(await service.setIfChanged('builders:all', 'A', 60)).toBe(false);
    expect(client.expire).toHaveBeenCalledWith('builders:all', 60);
    expect(client.set).not.toHaveBeenCalled();

    client.expire.mockResolvedValueOnce(0);
    expect(await service.setIfChanged('builders:all', 'A', 60)).toBe(true);
    expect(client.set).toHaveBeenCalledWith('builders:all', 'A', 'EX', 60);
  });

  it('writes an unchanged value again after 10 minutes', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    const { service, client } = load();
    await service.setIfChanged('k', 'A');
    client.set.mockClear();

    jest.setSystemTime(1_800_000_000_000 + 9 * 60_000);
    expect(await service.setIfChanged('k', 'A')).toBe(false);
    jest.setSystemTime(1_800_000_000_000 + 10 * 60_000);
    expect(await service.setIfChanged('k', 'A')).toBe(true);
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('writes again after a reconnection (Redis may have restarted with older data)', async () => {
    process.env.REDIS_AOF_OFF = 'false';
    const { service, client, ready } = load();
    await service.setIfChanged('k', 'A');
    client.set.mockClear();

    ready();
    expect(await service.setIfChanged('k', 'A')).toBe(true);
    expect(client.exists).not.toHaveBeenCalled();
  });

  it('after a failed write, the next call writes again', async () => {
    const { service, client } = load();
    client.set.mockRejectedValueOnce(new Error('Command timed out'));
    expect(await service.setIfChanged('k', 'A')).toBe(false);

    expect(await service.setIfChanged('k', 'A')).toBe(true);
    expect(client.set).toHaveBeenCalledTimes(2);
    expect(client.exists).not.toHaveBeenCalled();
  });
});

describe('Redis AOF guard', () => {
  it('in production, turns the AOF off on connection, then refreshes the file after 2 min and every 30 min', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_AOF_OFF;
    jest.useFakeTimers();
    const { client, ready } = load();
    client.config.mockImplementation(async (op: string) => (op === 'GET' ? ['appendonly', 'yes'] : 'OK'));

    ready();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.config).toHaveBeenCalledWith('SET', 'appendonly', 'no');
    client.config.mockImplementation(async (op: string) => (op === 'GET' ? ['appendonly', 'no'] : 'OK'));

    await jest.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(client.bgrewriteaof).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(client.bgrewriteaof).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.bgrewriteaof).toHaveBeenCalledTimes(2);
  });

  it('turns the AOF off again when it came back on without a reconnection', async () => {
    process.env.REDIS_AOF_OFF = 'true';
    jest.useFakeTimers();
    const { client, ready } = load();
    ready();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.config).not.toHaveBeenCalledWith('SET', 'appendonly', 'no');

    client.config.mockImplementation(async (op: string) => (op === 'GET' ? ['appendonly', 'yes'] : 'OK'));
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(client.config).toHaveBeenCalledWith('SET', 'appendonly', 'no');
    expect(client.bgrewriteaof).toHaveBeenCalledTimes(1);
  });

  it('frequent reconnections do not postpone the refresh', async () => {
    process.env.REDIS_AOF_OFF = 'true';
    jest.useFakeTimers();
    const { client, ready } = load();
    ready();
    await jest.advanceTimersByTimeAsync(90_000);
    ready();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.bgrewriteaof).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['REDIS_AOF_OFF=false in production', 'production', 'false'],
    ['unset outside production', 'development', undefined],
  ])('does nothing with %s', async (_label, nodeEnv, flag) => {
    process.env.NODE_ENV = nodeEnv;
    if (flag === undefined) delete process.env.REDIS_AOF_OFF;
    else process.env.REDIS_AOF_OFF = flag;
    jest.useFakeTimers();
    const { client, ready } = load();
    ready();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(client.config).not.toHaveBeenCalled();
    expect(client.bgrewriteaof).not.toHaveBeenCalled();
  });

  it('stops for good when the server refuses CONFIG', async () => {
    process.env.REDIS_AOF_OFF = 'true';
    jest.useFakeTimers();
    const { client, ready } = load();
    client.config.mockRejectedValue(new Error("ERR unknown command 'CONFIG'"));
    ready();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    ready();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(client.config).toHaveBeenCalledTimes(1);
    expect(client.bgrewriteaof).not.toHaveBeenCalled();
  });

  it('a refresh due while the Redis circuit is open is tried again a minute later', async () => {
    process.env.REDIS_AOF_OFF = 'true';
    jest.useFakeTimers();
    const { service, client, ready } = load();
    ready();
    await jest.advanceTimersByTimeAsync(2 * 60_000 - 5_000);
    // Five failed commands open the circuit for 15 s, across the refresh time.
    client.set.mockRejectedValue(new Error('Command timed out'));
    for (let i = 0; i < 5; i++) await service.setIfChanged(`k${i}`, 'v');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(client.bgrewriteaof).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(client.bgrewriteaof).toHaveBeenCalledTimes(1);
  });

  it('a refresh that fails for a passing reason is tried again 30 min later', async () => {
    process.env.REDIS_AOF_OFF = 'true';
    jest.useFakeTimers();
    const { client, ready } = load();
    client.bgrewriteaof.mockRejectedValueOnce(new Error('ERR Background append only file rewriting already in progress'));
    ready();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(client.bgrewriteaof).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.bgrewriteaof).toHaveBeenCalledTimes(2);
  });
});
