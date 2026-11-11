/**
 * The limits every connection of the writers' pool carries, on a real Postgres. They are set
 * when the pool is created, so the code is loaded here after the environment is prepared.
 */
jest.mock('../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Client = {
  $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
  $transaction: <T>(fn: (tx: Client) => Promise<T>, options?: { timeout?: number }) => Promise<T>;
  $disconnect: () => Promise<void>;
};
let writers: Client;
let pages: Client;

beforeAll(async () => {
  // Short enough to see a lock wait end within the test.
  process.env.HISTORICAL_WRITE_LOCK_TIMEOUT_MS = '1500';
  const mod = (await import('../../src/core/prisma.historical.service')) as unknown as { prismaHistorical: Client; prismaHistoricalPages: Client };
  writers = mod.prismaHistorical;
  pages = mod.prismaHistoricalPages;
  await writers.$executeRawUnsafe(`DELETE FROM elysium_ingest_state WHERE stream = 'probe'`);
});

afterAll(async () => {
  delete process.env.HISTORICAL_WRITE_LOCK_TIMEOUT_MS;
  await writers.$executeRawUnsafe(`DELETE FROM elysium_ingest_state WHERE stream = 'probe'`);
  await Promise.all([writers.$disconnect(), pages.$disconnect()]);
});

const show = async (db: Client, name: string): Promise<string> => (await db.$queryRawUnsafe<Array<Record<string, string>>>(`SHOW ${name}`))[0][name];

it('every connection of the writers\' pool has a statement limit, a lock-wait limit and an idle-transaction limit', async () => {
  expect([await show(writers, 'statement_timeout'), await show(writers, 'lock_timeout'), await show(writers, 'idle_in_transaction_session_timeout')]).toEqual(['10min', '1500ms', '5min']);
});

it('a long job still sets its own limit inside its transaction', async () => {
  const inside = await writers.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 900000`);
    return show(tx, 'statement_timeout');
  });
  expect(inside).toBe('15min');
});

it('a write that waits on a row someone else holds gives up at the limit instead of waiting for the holder', async () => {
  await writers.$executeRawUnsafe(`INSERT INTO elysium_ingest_state (stream, rows) VALUES ('probe', 0)`);
  const holder = pages.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT 1 FROM elysium_ingest_state WHERE stream = 'probe' FOR UPDATE`);
    await tx.$queryRawUnsafe(`SELECT pg_sleep(6)::text`);
  }, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 500));
  const started = Date.now();
  let code = '';
  try {
    await writers.$executeRawUnsafe(`UPDATE elysium_ingest_state SET rows = rows + 1 WHERE stream = 'probe'`);
  } catch (e) {
    code = String((e as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause?.originalCode ?? (e as Error).message.slice(0, 80));
  }
  const waited = Date.now() - started;
  await holder;
  expect(code).toBe('55P03');
  expect(waited).toBeGreaterThanOrEqual(1300);
  expect(waited).toBeLessThan(4000);
});
