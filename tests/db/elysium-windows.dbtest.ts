/**
 * The hour rollups and the window tables, on a real Postgres: what the builder writes, what marks
 * an hour to be rebuilt, and that a view read through a window table says exactly what the same
 * view says from the rollups alone, at every stage of a sequence in time (an hour that closes,
 * midnight, a late transaction, a class that changes, a contract that is removed).
 */
jest.mock('../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../src/core/redis.service', () => ({ redisService: { getClient: () => ({}) } }));
// No cache: a view's lookups (the selector names) are read from the database each time.
jest.mock('../../src/core/cache.service', () => ({
  cacheService: { getOrSet: (_key: string, fn: () => Promise<unknown>) => fn() },
}));

import { prismaHistoricalAggregate, prismaHistoricalPages, prismaHistoricalRead } from '../../src/core/prisma.historical.service';
import { ElysiumCheckRepository } from '../../src/repositories/prisma/prisma.elysium-check.repository';
import { ElysiumIngestRepository } from '../../src/repositories/prisma/prisma.elysium.repository';
import { ElysiumWindowRepository } from '../../src/repositories/prisma/prisma.elysium-window.repository';
import { ElysiumAnalyticsService } from '../../src/services/elysium/elysium-analytics.service';
import { planWindow, readRollupCoverage } from '../../src/services/elysium/elysium-rollup.reader';
import { ElysiumRollupService } from '../../src/services/elysium/elysium-rollup.service';
import { HOUR_MS, WINDOW_SPANS } from '../../src/services/elysium/elysium-rollup.util';
import * as windowReader from '../../src/services/elysium/elysium-window.reader';
import { windowDelta } from '../../src/services/elysium/elysium-window.util';
import { A, H, disconnect, q, wipe, x, type TxFixture } from './helpers';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const ingest = ElysiumIngestRepository.getInstance();
const check = ElysiumCheckRepository.getInstance();
const windows = ElysiumWindowRepository.getInstance();
const builder = ElysiumRollupService.getInstance();

type View = { compute: () => Promise<Record<string, unknown>> };
const analytics = ElysiumAnalyticsService.getInstance() as unknown as {
  feesView: (window: string) => View;
  contractsView: (window: string) => View;
  economicsView: (days: number) => View;
  methodsView: (window: string) => View;
};

// The addresses of the data. Contracts are deployed by two deployers; one token is only in the
// registry; one address receives transfers days before a contract is deployed at it.
const DEP1 = A(0xd1);
const DEP2 = A(0xd2);
const CONTRACTS = [1, 2, 3, 4, 5, 6].map((i) => A(0xc000 + i));
const TOKEN_ONLY = A(0x7001);
const LATE_CONTRACT = A(0x7002);
const LATE_TOKEN = A(0x7003);
const PRECOMPILE = '0x' + '0'.repeat(38) + '64';
const EOAS = Array.from({ length: 20 }, (_, i) => A(0xe000 + i));
const METHODS = ['0xa9059cbb', '0x095ea7b3', '0x38ed1739', null];

/** The clock of the code under test: only Date is faked, the timers of the driver run for real. */
const BASE = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
function setClock(ms: number): void {
  jest.setSystemTime(ms);
}

let seq = 0;
function tx(at: number, patch: Partial<TxFixture> = {}): TxFixture {
  seq++;
  return {
    tx_hash: H(seq),
    block_number: String(seq),
    block_time: new Date(at).toISOString(),
    from_addr: A(0x5000 + (seq % 11)),
    to_addr: A(0xe000),
    contract_address: null,
    method_id: null,
    tx_type: '0x2',
    gas_used: String(21_000 + (seq % 9) * 1_000),
    fee_wei: String(BigInt(seq) * 1_000_000_000_000n),
    success: seq % 13 !== 0,
    is_spam: false,
    ...patch,
  };
}

/** Deterministic data over the last 9.5 days, up to two minutes before BASE. */
function seedRows(): TxFixture[] {
  let s = 12345;
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows: TxFixture[] = [];
  const first = BASE - 9.5 * DAY_MS;
  CONTRACTS.forEach((c, i) => rows.push(tx(first + i * 1_000, { to_addr: null, contract_address: c, from_addr: i < 4 ? DEP1 : DEP2 })));
  const targets = [...CONTRACTS, TOKEN_ONLY, LATE_CONTRACT, LATE_TOKEN, PRECOMPILE, ...EOAS];
  for (let t = first + 10 * MINUTE_MS; t < BASE - 2 * MINUTE_MS; t += 9 * MINUTE_MS) {
    const r = rnd();
    const target = targets[Math.floor(rnd() * rnd() * targets.length)];
    // The address a contract is deployed at later only receives plain transfers before.
    const isContract = CONTRACTS.includes(target) || target === TOKEN_ONLY || target === LATE_TOKEN;
    rows.push(
      tx(t + Math.floor(rnd() * 8 * MINUTE_MS), {
        to_addr: target,
        method_id: isContract ? METHODS[Math.floor(rnd() * METHODS.length)] : null,
        is_spam: r < 0.08,
        tx_type: r > 0.95 ? '0x64' : '0x2',
      })
    );
  }
  // A contract created in the last hours: only in the edges of every window.
  rows.push(tx(BASE - 3 * HOUR_MS, { to_addr: null, contract_address: A(0xc0ff), from_addr: DEP2 }));
  rows.push(tx(BASE - 3 * HOUR_MS + 30_000, { to_addr: A(0xc0ff), method_id: '0xa9059cbb' }));
  return rows.sort((a, b) => a.block_time.localeCompare(b.block_time));
}

async function insertAll(rows: TxFixture[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 400) await ingest.insertTxs(rows.slice(i, i + 400));
}

/** The builder's passes until it has nothing left to do, with the tx stream's cursor at the clock. */
async function build(): Promise<void> {
  await x(
    `INSERT INTO elysium_ingest_state (stream, cursor, backfill_done) VALUES ('tx', $1::timestamptz, true)
     ON CONFLICT (stream) DO UPDATE SET cursor = EXCLUDED.cursor`,
    new Date(Date.now()).toISOString()
  );
  let idle = 0;
  for (let i = 0; i < 300 && idle < 2; i++) idle = (await builder.tick()) > 5_000 ? idle + 1 : 0;
  expect(idle).toBe(2);
}

const strip = (v: Record<string, unknown>): Record<string, unknown> => {
  const { from: _from, to: _to, ...rest } = v;
  return rest;
};

/**
 * Every view that can read a window table, computed through the tables and from the rollups
 * alone at the same instant: the two must say the same. Returns how many reads went through a table.
 */
async function sameBothWays(): Promise<{ fees: number; contracts: number }> {
  const fees = jest.spyOn(windowReader, 'feesFromWindow');
  const contracts = jest.spyOn(windowReader, 'topContractsFromWindow');
  const run = async (): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    for (const w of ['24h', '7d', '30d']) out[`fees ${w}`] = strip(await analytics.feesView(w).compute());
    for (const w of ['24h', '7d']) out[`contracts ${w}`] = strip(await analytics.contractsView(w).compute());
    return out;
  };
  const through = await run();
  const used = {
    fees: fees.mock.results.filter((r) => r.type === 'return').length,
    contracts: contracts.mock.results.filter((r) => r.type === 'return').length,
  };
  process.env.ELYSIUM_WINDOWS_ENABLED = 'false';
  try {
    const alone = await run();
    expect(through).toEqual(alone);
  } finally {
    delete process.env.ELYSIUM_WINDOWS_ENABLED;
  }
  fees.mockRestore();
  contracts.mockRestore();
  return used;
}

/** Each window table against elysium_tx, over the days and hours its state row lists. */
async function tablesMatchRaw(): Promise<void> {
  for (const span of WINDOW_SPANS) {
    const diff = await q<{ to_addr: string }>(
      `WITH st AS (SELECT cover_days, cover_hours FROM elysium_window_state WHERE span = $1::smallint),
       ranges AS (
         SELECT (d->>'day')::date::timestamp AT TIME ZONE 'UTC' AS a, ((d->>'day')::date + 1)::timestamp AT TIME ZONE 'UTC' AS b
         FROM st, jsonb_array_elements(st.cover_days) d
         UNION ALL
         SELECT to_timestamp((h->>'hour')::float8 / 1000), to_timestamp((h->>'hour')::float8 / 1000) + interval '1 hour'
         FROM st, jsonb_array_elements(st.cover_hours) h
       ),
       want AS (
         SELECT t.to_addr, count(*)::int AS txs, sum(t.fee_wei) AS fee, sum(t.gas_used)::bigint AS gas
         FROM elysium_tx t JOIN ranges r ON t.block_time >= r.a AND t.block_time < r.b
         WHERE NOT t.is_spam AND t.to_addr IS NOT NULL GROUP BY t.to_addr
       ),
       got AS (SELECT to_addr, txs, fee_wei AS fee, gas_used AS gas FROM elysium_target_window WHERE span = $1::smallint AND txs > 0)
       SELECT COALESCE(w.to_addr, g.to_addr) AS to_addr FROM want w FULL JOIN got g USING (to_addr)
       WHERE (w.txs, w.fee, w.gas) IS DISTINCT FROM (g.txs, g.fee, g.gas)`,
      span
    );
    expect({ span, differing: diff.map((d) => d.to_addr) }).toEqual({ span, differing: [] });
    // The totals per class and the sums per deployer are the sums of the rows.
    const totals = await q<{ ok: boolean; dep_ok: boolean }>(
      `SELECT (SELECT (s.app_txs, s.app_fee_wei, s.app_n, s.other_txs, s.system_txs)
                    = ((SELECT COALESCE(sum(txs), 0) FROM elysium_target_window WHERE span = s.span AND kind = 1),
                       (SELECT COALESCE(sum(fee_wei), 0) FROM elysium_target_window WHERE span = s.span AND kind = 1),
                       (SELECT count(*) FROM elysium_target_window WHERE span = s.span AND kind = 1 AND txs > 0),
                       (SELECT COALESCE(sum(txs), 0) FROM elysium_target_window WHERE span = s.span AND kind = 0),
                       (SELECT COALESCE(sum(txs), 0) FROM elysium_target_window WHERE span = s.span AND kind = 2))
               FROM elysium_window_state s WHERE s.span = $1::smallint) AS ok,
              NOT EXISTS (
                SELECT 1 FROM (
                  SELECT deployer, sum(txs) AS txs, sum(fee_wei) AS fee, count(*) FILTER (WHERE txs > 0) AS n
                  FROM elysium_target_window WHERE span = $1::smallint AND deployer IS NOT NULL GROUP BY deployer
                  HAVING count(*) FILTER (WHERE txs > 0) > 0
                ) w FULL JOIN (SELECT deployer, txs, fee_wei AS fee, contracts AS n FROM elysium_deployer_window WHERE span = $1::smallint) d USING (deployer)
                WHERE (w.txs, w.fee, w.n) IS DISTINCT FROM (d.txs, d.fee, d.n)
              ) AS dep_ok`,
      span
    );
    expect({ span, ...totals[0] }).toEqual({ span, ok: true, dep_ok: true });
  }
}

const kindOf = async (span: number, address: string): Promise<{ kind: number; deployer: string | null } | undefined> =>
  (await q<{ kind: number; deployer: string | null }>(`SELECT kind, deployer FROM elysium_target_window WHERE span = $1::smallint AND to_addr = $2`, span, address))[0];

beforeAll(async () => {
  jest.useFakeTimers({
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    now: BASE - 30 * HOUR_MS,
  });
  await wipe();
  await x(`INSERT INTO elysium_token (address, standard, name, symbol, transfer_count) VALUES ($1, 'erc20', 'Registry Only', 'REG', 5)`, TOKEN_ONLY);
  await insertAll(seedRows());
});

afterAll(async () => {
  jest.useRealTimers();
  await wipe();
  await Promise.all([prismaHistoricalAggregate.$disconnect(), prismaHistoricalPages.$disconnect(), prismaHistoricalRead.$disconnect()]);
  await disconnect();
});

describe('hour rollups', () => {
  it('builds the hours the windows` edges need, each one equal to its hour of elysium_tx', async () => {
    await build();
    const hours = await q<{ hour_ms: number; built: boolean; dirty: boolean }>(
      `SELECT (extract(epoch FROM hour) * 1000)::float8 AS hour_ms, built_at IS NOT NULL AS built, dirty FROM elysium_hour_rollup ORDER BY hour`
    );
    const clock = Date.now();
    const clean = hours.filter((h) => h.built && !h.dirty).map((h) => Number(h.hour_ms));
    // The last 50 hours behind the clock (the one in progress apart).
    for (let h = Math.floor(clock / HOUR_MS) * HOUR_MS - HOUR_MS, i = 0; i < 50; i++, h -= HOUR_MS) expect(clean).toContain(h);
    // And the first whole hour of a 7-day window.
    expect(clean).toContain(Math.floor((clock - 7 * DAY_MS) / HOUR_MS) * HOUR_MS + HOUR_MS);

    const wrong = await q(
      `WITH want AS (
         SELECT date_trunc('hour', block_time, 'UTC') AS hour, to_addr, COALESCE(method_id, '') AS method_id,
                count(*)::int AS txs, count(*) FILTER (WHERE NOT success)::int AS failed, sum(fee_wei) AS fee, sum(gas_used)::bigint AS gas
         FROM elysium_tx WHERE NOT is_spam AND to_addr IS NOT NULL
           AND date_trunc('hour', block_time, 'UTC') IN (SELECT hour FROM elysium_hour_rollup WHERE built_at IS NOT NULL AND NOT dirty)
         GROUP BY 1, 2, 3
       )
       SELECT COALESCE(w.hour, h.hour) FROM want w
       FULL JOIN (SELECT hour, to_addr, method_id, txs, failed, fee_wei AS fee, gas_used AS gas FROM elysium_call_hour
                  WHERE hour IN (SELECT hour FROM elysium_hour_rollup WHERE built_at IS NOT NULL AND NOT dirty)) h
         USING (hour, to_addr, method_id)
       WHERE (w.txs, w.failed, w.fee, w.gas) IS DISTINCT FROM (h.txs, h.failed, h.fee, h.gas)`
    );
    expect(wrong).toEqual([]);
    const totals = await q(
      `SELECT r.hour FROM elysium_hour_rollup r
       CROSS JOIN LATERAL (
         SELECT count(*) FILTER (WHERE NOT is_spam)::int AS txs, count(*) FILTER (WHERE is_spam)::int AS spam,
                count(*) FILTER (WHERE NOT is_spam AND NOT success)::int AS failed,
                count(*) FILTER (WHERE NOT is_spam AND to_addr IS NULL)::int AS creations,
                COALESCE(sum(fee_wei), 0) AS fee
         FROM elysium_tx t WHERE t.block_time >= r.hour AND t.block_time < r.hour + interval '1 hour'
       ) w
       WHERE r.built_at IS NOT NULL AND NOT r.dirty
         AND (r.txs, r.spam_txs, r.failed_txs, r.creations, r.fee_wei) IS DISTINCT FROM (w.txs, w.spam, w.failed, w.creations, w.fee)`
    );
    expect(totals).toEqual([]);
  });

  it('a transaction stored for an hour that is over marks the hour to be rebuilt, and the builder redoes it', async () => {
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 5 * HOUR_MS;
    const state = async (): Promise<{ dirty: boolean; txs: number }> =>
      (await q<{ dirty: boolean; txs: number }>(`SELECT dirty, txs FROM elysium_hour_rollup WHERE hour = $1::timestamptz`, new Date(hour).toISOString()))[0];
    const before = await state();
    expect(before.dirty).toBe(false);
    await ingest.insertTxs([tx(hour + 17 * MINUTE_MS, { to_addr: CONTRACTS[0], method_id: '0xa9059cbb' })]);
    expect((await state()).dirty).toBe(true);
    // Read meanwhile, the hour comes from elysium_tx: both ways still agree.
    await sameBothWays();
    await build();
    expect(await state()).toEqual({ dirty: false, txs: before.txs + 1 });
  });

  it('a flag applied to a transaction, or a transaction removed, marks its hour too', async () => {
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 7 * HOUR_MS;
    const row = tx(hour + 5 * MINUTE_MS, { to_addr: CONTRACTS[1], method_id: '0x095ea7b3' });
    await ingest.insertTxs([row]);
    await build();
    const dirty = async (): Promise<boolean> =>
      (await q<{ dirty: boolean }>(`SELECT dirty FROM elysium_hour_rollup WHERE hour = $1::timestamptz`, new Date(hour).toISOString()))[0].dirty;
    expect(await dirty()).toBe(false);
    await check.applyTxFlags([{ ...row, is_spam: true } as never]);
    expect(await dirty()).toBe(true);
    await build();
    expect(await dirty()).toBe(false);
    await check.removeTxs([row.tx_hash]);
    expect(await dirty()).toBe(true);
    await build();
  });
});

describe('window tables', () => {
  it('each table is the sum of elysium_tx over the days and hours its state lists, with the class of each address', async () => {
    await build();
    const states = await q<{ span: number; ready: boolean; days: number; hours: number }>(
      `SELECT span, ready, jsonb_array_length(cover_days) AS days, jsonb_array_length(cover_hours) AS hours
       FROM elysium_window_state WHERE span > 0 ORDER BY span`
    );
    expect(states.map((s) => [s.span, s.ready])).toEqual([[1, true], [7, true], [30, true]]);
    expect(states[0].days).toBe(0);
    expect(states[1].days).toBe(6);
    await tablesMatchRaw();
    expect(await kindOf(7, CONTRACTS[0])).toEqual({ kind: 1, deployer: DEP1 });
    expect(await kindOf(7, CONTRACTS[5])).toEqual({ kind: 1, deployer: DEP2 });
    expect(await kindOf(7, TOKEN_ONLY)).toEqual({ kind: 1, deployer: null });
    expect(await kindOf(7, PRECOMPILE)).toEqual({ kind: 2, deployer: null });
    expect(await kindOf(7, EOAS[0])).toEqual({ kind: 0, deployer: null });
  });

  it('a view read through its table says what the rollups alone say', async () => {
    const used = await sameBothWays();
    expect(used).toEqual({ fees: 3, contracts: 2 });
  });

  it('still does a few minutes later, and once an hour has closed, before and after the builder`s pass', async () => {
    setClock(Date.now() + 7 * MINUTE_MS);
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
    setClock(Math.floor(Date.now() / HOUR_MS) * HOUR_MS + HOUR_MS + 4 * MINUTE_MS);
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
    await build();
    await tablesMatchRaw();
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
  });

  it('follows midnight: the edges first, then the base once yesterday is built', async () => {
    const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS;
    setClock(midnight - 2 * MINUTE_MS);
    await build();
    setClock(midnight);
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
    setClock(midnight + 90_000);
    // Not refreshed yet: a day comes off the 7 and 30 day tables, the hours left of it are added.
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
    await build();
    await tablesMatchRaw();
    const base = async (): Promise<string[]> =>
      (await q<{ day: string }>(`SELECT d->>'day' AS day FROM elysium_window_state s, jsonb_array_elements(s.base_days) d WHERE s.span = 7 ORDER BY 1`)).map((r) => r.day);
    const yesterday = new Date(midnight - DAY_MS).toISOString().slice(0, 10);
    // Yesterday is not closed (the stream is 90 s into today): the base still holds the day that left.
    expect(await base()).not.toContain(yesterday);
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });

    setClock(midnight + 13 * MINUTE_MS);
    await build();
    expect(await base()).toContain(yesterday);
    expect(await base()).toHaveLength(6);
    await tablesMatchRaw();
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
  });

  it('a late transaction in a day and an hour already built: the tables are left until both are rebuilt', async () => {
    const at = Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * HOUR_MS;
    await ingest.insertTxs([tx(at, { to_addr: CONTRACTS[2], method_id: '0x38ed1739' }), tx(at + 1_000, { to_addr: EOAS[3] })]);
    await sameBothWays();
    await build();
    await tablesMatchRaw();
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
  });

  it('an address that becomes a known contract is classed on the builder`s pass over the classes', async () => {
    expect((await kindOf(30, LATE_TOKEN))?.kind).toBe(0);
    expect((await kindOf(30, LATE_CONTRACT))?.kind).toBe(0);
    const apps = async (): Promise<number> => (await q<{ n: number }>(`SELECT app_n AS n FROM elysium_window_state WHERE span = 30`))[0].n;
    const before = await apps();
    // A token entered in the registry after its calls, and a contract deployed at an address that had received transfers.
    await x(`INSERT INTO elysium_token (address, standard, name, symbol, transfer_count) VALUES ($1, 'erc20', 'Late', 'LATE', 1)`, LATE_TOKEN);
    await ingest.insertTxs([tx(Date.now() - 20 * MINUTE_MS, { to_addr: null, contract_address: LATE_CONTRACT, from_addr: DEP1 })]);
    const changed = await windows.reclassify();
    expect(changed).not.toBe('busy');
    expect((changed as Map<number, number>).get(30)).toBe(2);
    expect(await kindOf(30, LATE_TOKEN)).toEqual({ kind: 1, deployer: null });
    expect(await kindOf(30, LATE_CONTRACT)).toEqual({ kind: 1, deployer: DEP1 });
    expect(await apps()).toBe(before + 2);
    await tablesMatchRaw();
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
    // Nothing left to change: the pass leaves the tables' versions alone.
    const version = async (): Promise<string> => (await q<{ v: string }>(`SELECT version::text AS v FROM elysium_window_state WHERE span = 30`))[0].v;
    const v = await version();
    expect((await windows.reclassify()) as Map<number, number>).toEqual(new Map());
    expect(await version()).toBe(v);
  });

  it('a contract that is removed: the tables are not read until they are worked out again from nothing', async () => {
    const victim = CONTRACTS[3];
    const creation = (await q<{ deploy_tx: string }>(`SELECT deploy_tx FROM elysium_contract WHERE address = $1`, victim))[0].deploy_tx;
    expect((await kindOf(30, victim))?.kind).toBe(1);
    await check.removeTxs([creation]);
    // The tables still hold it as a contract: no read goes through them.
    expect(await sameBothWays()).toEqual({ fees: 0, contracts: 0 });
    await build();
    expect(await kindOf(30, victim)).toEqual({ kind: 0, deployer: null });
    await tablesMatchRaw();
    expect(await sameBothWays()).toEqual({ fees: 3, contracts: 2 });
  });

  it('a reader that planned with a table changed since drops what it read', async () => {
    const now = new Date(Date.now());
    const coverage = await readRollupCoverage(now);
    const state = coverage.windows.get(7)!;
    const plan = planWindow(new Date(now.getTime() - 7 * DAY_MS), now, coverage);
    const delta = windowDelta(plan, state, coverage.built, coverage.epoch)!;
    expect(delta).not.toBeNull();
    await expect(windowReader.feesFromWindow(state, plan, delta)).resolves.not.toBeNull();
    await expect(windowReader.feesFromWindow({ ...state, version: String(BigInt(state.version) + 1n) }, plan, delta)).resolves.toBeNull();
    // A rollup it takes off that is not the one the table was read from.
    const hour = state.coverHours[0];
    const taken = { ...delta, subHours: [{ hour: hour.hour, at: hour.at + 1 }] };
    await expect(windowReader.topContractsFromWindow(state, plan, taken)).resolves.toBeNull();
  });

  it('refuses to bring a table to rollups that are not the ones the caller read', async () => {
    const now = new Date(Date.now());
    const coverage = await readRollupCoverage(now);
    const state = coverage.windows.get(7)!;
    const version = state.version;
    const moved = { days: state.coverDays.map((d, i) => (i === 0 ? { ...d, at: d.at + 1 } : d)), hours: state.coverHours };
    await expect(windows.refresh(7, moved, { rebase: false })).resolves.toBe('stale');
    expect((await q<{ v: string }>(`SELECT version::text AS v FROM elysium_window_state WHERE span = 7`))[0].v).toBe(version);
    await expect(windows.refresh(9, moved, { rebase: false })).rejects.toThrow('Invalid window span');
  });

  it('the other views that read the hours agree with elysium_tx', async () => {
    const economics = (await analytics.economicsView(14).compute()) as { daily: Array<{ day: string; txs: number; spamTxs: number; feesHype: number }> };
    const raw = await q<{ day: string; txs: number; spam: number; fee: number }>(
      `SELECT (block_time AT TIME ZONE 'UTC')::date::text AS day, count(*) FILTER (WHERE NOT is_spam)::int AS txs,
              count(*) FILTER (WHERE is_spam)::int AS spam, (sum(fee_wei) / 1e18)::float8 AS fee
       FROM elysium_tx GROUP BY 1`
    );
    const byDay = new Map(raw.map((r) => [r.day.slice(0, 10), r]));
    for (const d of economics.daily) {
      const want = byDay.get(d.day);
      expect([d.day, d.txs, d.spamTxs]).toEqual([d.day, want?.txs ?? 0, want?.spam ?? 0]);
      expect(d.feesHype).toBeCloseTo(want?.fee ?? 0, 12);
    }
    const methods = (await analytics.methodsView('7d').compute()) as { totals: { calls: number }; rows: Array<{ methodId: string; txs: number; senders: number; contracts: number }> };
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const until = new Date(Date.now()).toISOString();
    const want = await q<{ method_id: string; txs: number; senders: number; contracts: number }>(
      `SELECT method_id, count(*)::int AS txs, count(DISTINCT from_addr)::int AS senders, count(DISTINCT to_addr)::int AS contracts
       FROM elysium_tx WHERE block_time >= $1::timestamptz AND block_time < $2::timestamptz AND NOT is_spam AND to_addr IS NOT NULL AND method_id IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC, 1`,
      since,
      until
    );
    expect(methods.rows.map((r) => [r.methodId, r.txs, r.senders, r.contracts])).toEqual(want.map((r) => [r.method_id, r.txs, r.senders, r.contracts]));
    expect(methods.totals.calls).toBe(want.reduce((s, r) => s + r.txs, 0));
  });
});
