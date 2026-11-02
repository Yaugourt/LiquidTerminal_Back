import { isReady } from '../../../src/routes/health.readiness';

const up = { status: 'up' as const };
const down = { status: 'down' as const, error: 'x' };
const checks = (dbUp: boolean, redisUp: boolean) => ({
  database: dbUp ? up : down,
  contentDatabase: up,
  telegramDatabase: up,
  historicalDatabase: up,
  redis: redisUp ? up : down,
});

describe('readiness gate', () => {
  it('is ready when Core DB is up, even if Redis is down (cache, in-memory fallback)', () => {
    expect(isReady('ready', checks(true, false))).toBe(true);
  });

  it('is not ready when the Core DB is down', () => {
    expect(isReady('ready', checks(false, true))).toBe(false);
  });

  it('is not ready while still booting', () => {
    expect(isReady('booting', checks(true, true))).toBe(false);
  });
});
