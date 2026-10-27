/**
 * ioredis resolves pipeline.exec() with a per-command error (it does not reject)
 * when the stream is down or a command times out. claimKeys used to read that as
 * "key already exists" (false), so the AlertEngine dropped every alert as a
 * duplicate during a Redis outage instead of failing open.
 */
const mockPipelineResult: { current: Array<[Error | null, unknown]> | null } = { current: null };

jest.mock('ioredis', () => {
  const make = () => ({
    status: 'ready',
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    setMaxListeners: jest.fn(),
    ping: jest.fn(async () => 'PONG'),
    disconnect: jest.fn(),
    pipeline: () => {
      const p = { set: jest.fn(() => p), exec: async () => mockPipelineResult.current };
      return p;
    },
  });
  return { __esModule: true, default: jest.fn(make) };
});
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { redisService } from '../../../src/core/redis.service';

describe('RedisService.claimKeys', () => {
  it('returns per-key first-claim flags when every command succeeds', async () => {
    mockPipelineResult.current = [[null, 'OK'], [null, null]];
    expect(await redisService.claimKeys(['a', 'b'], 60)).toEqual([true, false]);
  });

  it('returns null (fail open) when the commands failed, not "already claimed"', async () => {
    mockPipelineResult.current = [
      [new Error('Stream isn\'t writeable and enableOfflineQueue options is false'), null],
      [new Error('Command timed out'), null],
    ];
    expect(await redisService.claimKeys(['a', 'b'], 60)).toBeNull();
  });
});
