/**
 * elysium_tx split by day, on a real Postgres: the split itself from a plain table (prepared,
 * verified, done in one transaction, given up while the table is busy), what the tx insert and
 * the daily comparison's corrections do across the day tables, and the dropping of old days
 * under a keep, with every condition that holds it back.
 */
jest.mock('../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../src/core/redis.service', () => ({ redisService: { getClient: () => ({}), get: async () => null, set: async () => undefined } }));

import { prismaHistorical, prismaHistoricalAggregate, prismaHistoricalPages, prismaHistoricalRead } from '../../src/core/prisma.historical.service';
import { ElysiumCheckRepository } from '../../src/repositories/prisma/prisma.elysium-check.repository';
import { ElysiumFactsRepository } from '../../src/repositories/prisma/prisma.elysium-facts.repository';
import { ElysiumPartitionRepository, LEGACY_PARTITION } from '../../src/repositories/prisma/prisma.elysium-partition.repository';
import { BUILD_LOCK_KEY, ElysiumRollupRepository } from '../../src/repositories/prisma/prisma.elysium-rollup.repository';
import { ElysiumIngestRepository } from '../../src/repositories/prisma/prisma.elysium.repository';
import { pgErrorCode } from '../../src/services/elysium/elysium-ingest.util';
import { partitionName, TX_KEEP_MIN_DAYS } from '../../src/services/elysium/elysium-retention.util';
import { ElysiumRollupService } from '../../src/services/elysium/elysium-rollup.service';
import { directoryContracts, ElysiumUpkeepService } from '../../src/services/elysium/elysium-upkeep.service';
import { A, H, disconnect, forgetSplitLayout, q, unsplit, wipe, wipeTables, x, type TxFixture } from './helpers';

const repo = ElysiumIngestRepository.getInstance();
const parts = ElysiumPartitionRepository.getInstance();
const check = ElysiumCheckRepository.getInstance();
const facts = ElysiumFactsRepository.getInstance();
const upkeep = ElysiumUpkeepService.getInstance() as unknown as { keepPartitions: (now: Date) => Promise<boolean> };

const DAY_MS = 86_400_000;
const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const day = (n: number): string => new Date(today - n * DAY_MS).toISOString().slice(0, 10);
const at = (n: number, seconds: number): string => new Date(today - n * DAY_MS + seconds * 1000).toISOString();

let seq = 0;
function tx(over: Partial<TxFixture> & { block_time: string }): TxFixture {
  seq += 1;
  return {
    tx_hash: H(0x14_0000 + seq),
    block_number: String(2_000_000 + seq),
    from_addr: A(0xf00),
    to_addr: A(0xc0),
    contract_address: null,
    method_id: '0xaaaaaaaa',
    tx_type: '0x2',
    gas_used: '21000',
    fee_wei: '1000000000000',
    success: true,
    is_spam: false,
    ...over,
  };
}
const where = async (hash: string): Promise<Array<{ part: string; at: string }>> =>
  q(
    `SELECT tableoid::regclass::text AS part, to_char(block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
     FROM elysium_tx WHERE tx_hash = $1 ORDER BY block_time`,
    hash
  );
const names = async (): Promise<string[]> => (await parts.layout()).parts.map((p) => p.name);

afterAll(async () => {
  // The layout the other test files expect.
  delete process.env.ELYSIUM_TX_KEEP_DAYS;
  await unsplit();
  await wipe();
  await Promise.all([prismaHistoricalAggregate.$disconnect(), prismaHistoricalPages.$disconnect(), prismaHistoricalRead.$disconnect()]);
  await disconnect();
});

describe('the split, from one plain table', () => {
  const cut = today + 2 * DAY_MS;
  const before = [tx({ block_time: at(40, 10) }), tx({ block_time: at(3, 20) }), tx({ block_time: at(0, 30) })];

  beforeAll(async () => {
    await unsplit();
    await wipeTables();
    await repo.insertTxs(before);
  });

  it('a plain table says so, stores as before and has no floor', async () => {
    expect(await parts.layout()).toEqual({ partitioned: false, parts: [], detaching: [], orphans: [], pending: null });
    expect(await parts.floorMs()).toBeNull();
    expect((await repo.insertTxs(before)).inserted).toBe(0);
  });

  it('is prepared (instant), then every row is checked, and each step is read back from the catalog', async () => {
    expect(await parts.prepare(cut)).toBe('done');
    expect((await parts.layout()).pending).toEqual({ cutMs: cut, validated: false });
    // Another bound replaces the first.
    expect(await parts.prepare(cut + DAY_MS)).toBe('done');
    expect((await parts.layout()).pending).toEqual({ cutMs: cut + DAY_MS, validated: false });
    expect(await parts.prepare(cut)).toBe('done');
    // The table still takes rows while it waits, on either side of nothing: all are before the bound.
    expect((await repo.insertTxs([tx({ block_time: at(0, 40) })])).inserted).toBe(1);
    await parts.validate();
    expect((await parts.layout()).pending).toEqual({ cutMs: cut, validated: true });
  });

  it('a row at or after the bound (the split was left unfinished for days) takes the bound off rather than being refused', async () => {
    const late = tx({ block_time: new Date(cut + 1000).toISOString() });
    expect((await repo.insertTxs([late])).inserted).toBe(1);
    expect((await parts.layout()).pending).toBeNull();
    // Back to where the split stood, for the tests below.
    await x(`DELETE FROM elysium_tx WHERE tx_hash = $1`, late.tx_hash);
    expect(await parts.prepare(cut)).toBe('done');
    await parts.validate();
  });

  it('is not done with a bound that is not the verified one, nor while a rollup build holds its lock', async () => {
    await expect(parts.split(cut + DAY_MS, [])).rejects.toThrow('not verified');
    expect((await parts.layout()).partitioned).toBe(false);
    // A build in another session: the split gives up at once and changes nothing.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let taken: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => (taken = resolve));
    const builder = prismaHistoricalPages.$transaction(
      async (t) => {
        await t.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, BUILD_LOCK_KEY);
        taken();
        await held;
      },
      { timeout: 60_000 }
    );
    await locked;
    expect(await parts.split(cut, [day(-2), day(-3)])).toBe('busy');
    expect((await parts.layout()).partitioned).toBe(false);
    release();
    await builder;
  });

  it('gives up within seconds while a statement holds the table, and is done once it is free', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let taken: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => (taken = resolve));
    const reader = prismaHistoricalPages.$transaction(
      async (t) => {
        await t.$queryRawUnsafe(`SELECT count(*) FROM elysium_tx`);
        taken();
        await held;
      },
      { timeout: 60_000 }
    );
    await locked;
    const started = Date.now();
    expect(await parts.split(cut, [day(-2), day(-3)])).toBe('busy');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await parts.layout()).partitioned).toBe(false);
    release();
    await reader;

    expect(await parts.split(cut, [day(-2), day(-3)])).toBe('done');
    const layout = await parts.layout();
    expect(layout.partitioned).toBe(true);
    expect(layout.parts).toEqual([
      { name: LEGACY_PARTITION, fromMs: null, toMs: cut },
      { name: partitionName(day(-2)), fromMs: cut, toMs: cut + DAY_MS },
      { name: partitionName(day(-3)), fromMs: cut + DAY_MS, toMs: cut + 2 * DAY_MS },
    ]);
  });

  it('copied nothing: the rows are where they were, under the same indexes, and the day tables have the same ones', async () => {
    expect(await q(`SELECT count(*)::int AS n FROM elysium_tx`)).toEqual([{ n: 4 }]);
    expect(await q(`SELECT count(*)::int AS n FROM ${LEGACY_PARTITION}`)).toEqual([{ n: 4 }]);
    const indexes = async (table: string): Promise<string[]> =>
      (await q<{ def: string }>(`SELECT regexp_replace(indexdef, '^.* USING ', '') AS def FROM pg_indexes WHERE tablename = $1 ORDER BY 1`, table)).map((r) => r.def);
    const legacy = await indexes(LEGACY_PARTITION);
    expect(legacy).toEqual(expect.arrayContaining(['btree (block_time)', 'btree (from_addr, block_time)', 'btree (to_addr, block_time)', 'btree (tx_hash)']));
    // No second copy of an index on the old table.
    expect(legacy.filter((d) => d === 'btree (block_time)')).toHaveLength(1);
    expect(await indexes(partitionName(day(-2)))).toEqual(['btree (block_time)', 'btree (from_addr, block_time)', 'btree (to_addr, block_time)', 'btree (tx_hash)']);
  });

  it('the insert stores on both sides of the bound and never stores a hash twice', async () => {
    const old = tx({ block_time: at(1, 50) });
    const fresh = tx({ block_time: at(-2, 60) });
    expect((await repo.insertTxs([old, fresh, ...before])).inserted).toBe(2);
    expect((await where(old.tx_hash))[0].part).toBe(LEGACY_PARTITION);
    expect((await where(fresh.tx_hash))[0].part).toBe(partitionName(day(-2)));
    expect((await repo.insertTxs([old, fresh])).inserted).toBe(0);
    // The same transaction under another time, in the same day table and in the one before it:
    // the provider moved it to another block. Not stored again; the daily comparison moves it.
    expect((await repo.insertTxs([{ ...fresh, block_time: at(-2, 61) }])).inserted).toBe(0);
    expect((await repo.insertTxs([{ ...fresh, block_time: at(-2, -30) }])).inserted).toBe(0);
    expect(await where(fresh.tx_hash)).toEqual([{ part: partitionName(day(-2)), at: at(-2, 60) }]);
  });

  it('a day without a table gets one from the insert that needs it, within the days ahead only', async () => {
    await x(`DROP TABLE "${partitionName(day(-3))}"`);
    const row = tx({ block_time: at(-3, 70) });
    expect((await repo.insertTxs([row])).inserted).toBe(1);
    expect((await where(row.tx_hash))[0].part).toBe(partitionName(day(-3)));
    // A time years ahead is a bad row, not a reason to make a table: refused, for the caller to set aside.
    const absurd = await repo.insertTxs([tx({ block_time: '2099-01-01T00:00:00.000Z' })]).catch((e: unknown) => e);
    expect(pgErrorCode(absurd)).toBe('23514');
    expect(await names()).not.toContain('elysium_tx_d20990101');
  });

  it('a day table is made once, by whoever asks first', async () => {
    const made = await Promise.all([parts.ensureDay(day(-4)), parts.ensureDay(day(-4)), parts.ensureDay(day(-4))]);
    expect(made.filter(Boolean)).toHaveLength(1);
    expect(await parts.ensureDay(day(-4))).toBe(false);
    expect(await names()).toContain(partitionName(day(-4)));
  });
});

describe('corrections across the day tables', () => {
  const sender = A(0x5e2);

  beforeAll(async () => {
    forgetSplitLayout();
    await unsplit();
    await wipe(); // the standard layout: a table per day from 75 days ago
  });

  it('a transaction the chain moved across midnight goes to the other day, with its sender counts', async () => {
    const row = tx({ block_time: at(2, 86_399), from_addr: sender });
    await repo.insertTxs([row]);
    expect((await where(row.tx_hash))[0].part).toBe(partitionName(day(2)));
    const moved = { ...row, block_time: at(1, 1), block_number: String(Number(row.block_number) + 1) };
    // The stream reads it again under its new time: left alone. The daily comparison moves it.
    expect((await repo.insertTxs([moved])).inserted).toBe(0);
    expect(await check.applyTxFlags([moved as never])).toBe(1);
    expect(await where(row.tx_hash)).toEqual([{ part: partitionName(day(1)), at: at(1, 1) }]);
    expect(await q(`SELECT day::text AS day, tx_count FROM elysium_address_day WHERE address = $1`, sender)).toEqual([{ day: day(1), tx_count: 1 }]);
    // Nothing more to apply.
    expect(await check.applyTxFlags([moved as never])).toBe(0);
  });

  it('a flag applied to a row leaves the other days alone, and a removal stays inside the span it was found in', async () => {
    const a = tx({ block_time: at(3, 100), from_addr: sender });
    const b = tx({ block_time: at(4, 100), from_addr: sender });
    await repo.insertTxs([a, b]);
    expect(await check.applyTxFlags([{ ...a, is_spam: true } as never])).toBe(1);
    expect(await q(`SELECT is_spam FROM elysium_tx WHERE tx_hash = ANY($1::text[]) ORDER BY block_time`, [a.tx_hash, b.tx_hash])).toEqual([{ is_spam: false }, { is_spam: true }]);
    // Asked to remove both hashes, but inside the ten minutes one of them is in.
    const start = new Date(Date.parse(b.block_time) - 100_000);
    const end = new Date(Date.parse(b.block_time) + 500_000);
    expect(await check.removeTxs([a.tx_hash, b.tx_hash], { start, end })).toBe(1);
    expect(await where(b.tx_hash)).toEqual([]);
    expect(await where(a.tx_hash)).toHaveLength(1);
    // Without a span the hash is looked for in every day.
    expect(await check.removeTxs([a.tx_hash])).toBe(1);
  });

  it('a contract whose creation is removed comes back from the other transaction that created it', async () => {
    const deployer = A(0xdeb);
    const created = A(0xc0de);
    const first = tx({ block_time: at(2, 500), from_addr: deployer, to_addr: null, contract_address: created, method_id: '0x60806040' });
    await repo.insertTxs([first]);
    // The chain put the creation in another block, under another hash (stored by hand: the insert
    // itself keeps the first creator of a contract).
    const second = tx({ block_time: at(2, 512), from_addr: deployer, to_addr: null, contract_address: created, method_id: '0x60806040' });
    await repo.insertTxs([second]);
    expect(await q(`SELECT deploy_tx FROM elysium_contract WHERE address = $1`, created)).toEqual([{ deploy_tx: first.tx_hash }]);
    await check.removeTxs([first.tx_hash], { start: new Date(Date.parse(first.block_time) - 1000), end: new Date(Date.parse(first.block_time) + 1000) });
    expect(await q(`SELECT deploy_tx, deployer FROM elysium_contract WHERE address = $1`, created)).toEqual([{ deploy_tx: second.tx_hash, deployer }]);
  });
});

describe('undoing the split, as the runbook says', () => {
  it('puts every row back in one plain table, which the insert then writes to as before', async () => {
    forgetSplitLayout();
    await unsplit();
    await wipeTables();
    const cut = today + 2 * DAY_MS;
    const old = tx({ block_time: at(3, 10) });
    await repo.insertTxs([old]);
    await parts.prepare(cut);
    await parts.validate();
    expect(await parts.split(cut, [day(-2)])).toBe('done');
    const fresh = tx({ block_time: at(-2, 10) });
    await repo.insertTxs([fresh]);
    expect((await where(fresh.tx_hash))[0].part).toBe(partitionName(day(-2)));

    // docs/ELYSIUM_RUNBOOK.md, section 9, statement by statement, in one transaction.
    await prismaHistorical.$transaction([
      prismaHistorical.$executeRawUnsafe(`LOCK TABLE elysium_tx IN ACCESS EXCLUSIVE MODE`),
      prismaHistorical.$executeRawUnsafe(`ALTER TABLE elysium_tx DETACH PARTITION elysium_tx_legacy`),
      prismaHistorical.$executeRawUnsafe(`ALTER TABLE elysium_tx_legacy DROP CONSTRAINT IF EXISTS elysium_tx_split_bound`),
      prismaHistorical.$executeRawUnsafe(`INSERT INTO elysium_tx_legacy SELECT * FROM elysium_tx ON CONFLICT (tx_hash) DO NOTHING`),
      prismaHistorical.$executeRawUnsafe(`DROP TABLE elysium_tx`),
      prismaHistorical.$executeRawUnsafe(`ALTER TABLE elysium_tx_legacy RENAME TO elysium_tx`),
    ]);
    parts.forgetFloor();

    expect(await parts.layout()).toEqual({ partitioned: false, parts: [], detaching: [], orphans: [], pending: null });
    expect(await q(`SELECT tx_hash FROM elysium_tx ORDER BY block_time`)).toEqual([{ tx_hash: old.tx_hash }, { tx_hash: fresh.tx_hash }]);
    // One table, one key on the hash: a hash is refused twice wherever its time is, as before the split.
    expect((await repo.insertTxs([old, fresh, tx({ block_time: at(0, 5) })])).inserted).toBe(1);
    expect(await q(`SELECT count(*)::int AS n FROM pg_class WHERE relname ~ '^elysium_tx_d[0-9]{8}$'`)).toEqual([{ n: 0 }]);
  });
});

describe('old days dropped under a keep', () => {
  const KEEP = TX_KEEP_MIN_DAYS; // 65
  const contracts = directoryContracts();
  const rollup = ElysiumRollupRepository.getInstance();
  const rollupBuilt = (n: number): Promise<number> =>
    x(`INSERT INTO elysium_day_rollup (day, built_at, dirty) VALUES ($1::date, now(), false) ON CONFLICT (day) DO UPDATE SET built_at = now(), dirty = false`, day(n));
  const factsThrough = async (n: number): Promise<void> => {
    await facts.ensureState();
    await facts.registerProjectContracts(contracts);
    await x(`UPDATE elysium_fact_state SET through_day = $1::date WHERE fact = 'history'`, day(n));
    await x(`UPDATE elysium_project_contract SET through_day = $1::date`, day(n));
  };
  const sendersCopied = (done: boolean): Promise<number> =>
    x(
      `INSERT INTO elysium_ingest_state (stream, cursor, backfill_done) VALUES ('txsender', now(), $1::boolean)
       ON CONFLICT (stream) DO UPDATE SET cursor = now(), backfill_done = $1::boolean`,
      done
    );
  const pass = (): Promise<boolean> => upkeep.keepPartitions(new Date());
  const OLD = [72, 70, 69, 68, 67, 66];
  const RECENT = [65, 64, 10, 1, 0];

  beforeAll(async () => {
    forgetSplitLayout();
    await unsplit();
    await wipe();
    // A row in each of a few old days, and in recent ones.
    await repo.insertTxs([...OLD, ...RECENT].map((n) => tx({ block_time: at(n, 1000) })));
    for (let n = 74; n >= 1; n--) await rollupBuilt(n);
    await sendersCopied(true);
  });

  it('nothing is dropped without a keep, whatever is old', async () => {
    delete process.env.ELYSIUM_TX_KEEP_DAYS;
    await factsThrough(10);
    const before = await names();
    expect(await pass()).toBe(false);
    expect(await names()).toEqual(before);
    expect(await q(`SELECT backfill_done, rows::int AS rows FROM elysium_ingest_state WHERE stream = 'txparts'`)).toEqual([{ backfill_done: true, rows: before.length }]);
  });

  it('nor while the history facts do not hold the old days, nor while the senders are not copied', async () => {
    process.env.ELYSIUM_TX_KEEP_DAYS = String(KEEP);
    await x(`UPDATE elysium_fact_state SET through_day = NULL`);
    const before = await names();
    expect(await pass()).toBe(false);
    expect(await names()).toEqual(before);
    // A directory contract that is not folded yet holds the days back too.
    await factsThrough(10);
    await x(`UPDATE elysium_project_contract SET through_day = NULL WHERE to_addr = $1`, contracts[0]);
    expect(await pass()).toBe(false);
    expect(await names()).toEqual(before);
    // And so does a copy of the senders that has not been through the history: a swap would lose its sender for good.
    await factsThrough(10);
    await sendersCopied(false);
    expect(await pass()).toBe(false);
    expect(await names()).toEqual(before);
    await sendersCopied(true);
  });

  it('then the days out of the keep go, two a pass, oldest first, and no day is left missing in the middle', async () => {
    expect(await pass()).toBe(true);
    let left = await names();
    expect(left).not.toContain(LEGACY_PARTITION);
    expect(left[0]).toBe(partitionName(day(74)));
    let passes = 1;
    while ((await pass()) && passes < 60) passes += 1;
    left = await names();
    expect(left[0]).toBe(partitionName(day(KEEP)));
    // Every day from the first kept one to the days ahead, none missing.
    expect(left).toEqual(Array.from({ length: left.length }, (_, i) => partitionName(day(KEEP - i))));
    expect(await q(`SELECT count(*)::int AS n FROM elysium_tx`)).toEqual([{ n: RECENT.length }]);
  });

  it('a row from before the oldest day kept is counted and left out; the days kept still take theirs', async () => {
    const floor = await parts.floorMs();
    expect(floor).toBe(today - KEEP * DAY_MS);
    const tooOld = tx({ block_time: at(70, 5) });
    const kept = tx({ block_time: at(KEEP, 5) });
    expect(await repo.insertTxs([tooOld, kept])).toMatchObject({ inserted: 1, tooOld: 1 });
    expect(await where(tooOld.tx_hash)).toEqual([]);
    expect(await repo.insertTxs([tooOld])).toMatchObject({ inserted: 0, tooOld: 1 });
    expect(await q(`SELECT (extract(epoch FROM cursor) * 1000)::float8 AS floor FROM elysium_ingest_state WHERE stream = 'txparts'`)).toEqual([{ floor }]);
    // No table is made again for a day that was dropped.
    expect(await parts.ensureDaysFor([day(70)], new Date())).toBe(0);
    expect(await names()).not.toContain(partitionName(day(70)));
  });

  it('the rollup of a dropped day is never built again: it is all that is left of the day', async () => {
    // Rollups kept longer than the transactions themselves (with the default spans a dropped day
    // is also out of the rollups' own keep, and the builder never looks at it).
    process.env.ELYSIUM_ROLLUP_KEEP_DAYS = '80';
    // Marked by hand, as one would for a day one does not trust.
    await x(`UPDATE elysium_day_rollup SET dirty = true WHERE day = $1::date`, day(70));
    await x(`INSERT INTO elysium_call_day (day, to_addr, method_id, txs, failed, fee_wei, gas_used) VALUES ($1::date, $2, '', 7, 0, 1, 1)`, day(70), A(0xc0));
    await expect(rollup.buildDay(day(70), { callers: false, senders: false })).rejects.toThrow('no longer held');
    await expect(rollup.buildHour(today - 70 * DAY_MS)).rejects.toThrow('no longer held');
    // The builder's own pass leaves the day out, and its figures stay.
    await repo.advance('tx', { cursor: new Date(), backfillDone: true });
    await ElysiumRollupService.getInstance().tick();
    expect(await q(`SELECT txs FROM elysium_call_day WHERE day = $1::date`, day(70))).toEqual([{ txs: 7 }]);
    // A day that is still held is built as before.
    expect(await rollup.buildDay(day(KEEP), { callers: false, senders: false })).toBe('built');
    delete process.env.ELYSIUM_ROLLUP_KEEP_DAYS;
  });

  it('the keep never goes under what the views read from elysium_tx', async () => {
    process.env.ELYSIUM_TX_KEEP_DAYS = '35';
    const before = await names();
    await pass();
    expect(await names()).toEqual(before);
  });

  it('a drop that stopped between its two statements is finished by the next pass', async () => {
    process.env.ELYSIUM_TX_KEEP_DAYS = String(KEEP);
    // The oldest day taken out of the table by hand, its own table left behind.
    const oldest = (await names())[0];
    await x(`ALTER TABLE elysium_tx DETACH PARTITION "${oldest}"`);
    expect((await parts.layout()).orphans).toEqual([oldest]);
    await pass();
    expect((await parts.layout()).orphans).toEqual([]);
    expect(await q(`SELECT count(*)::int AS n FROM pg_class WHERE relname = $1`, oldest)).toEqual([{ n: 0 }]);
  });
});

describe('the upkeep pass on a plain table', () => {
  beforeAll(async () => {
    delete process.env.ELYSIUM_TX_KEEP_DAYS;
    forgetSplitLayout();
    await unsplit();
    await wipeTables();
    await repo.insertTxs([tx({ block_time: at(5, 10) }), tx({ block_time: at(0, 10) })]);
  });

  afterAll(() => {
    delete process.env.ELYSIUM_TX_SPLIT_ENABLED;
  });

  it('does not split unless ELYSIUM_TX_SPLIT_ENABLED=true (an earlier release could not write to a split table)', async () => {
    for (const value of [undefined, 'false', '1', 'yes']) {
      if (value === undefined) delete process.env.ELYSIUM_TX_SPLIT_ENABLED;
      else process.env.ELYSIUM_TX_SPLIT_ENABLED = value;
      expect(await upkeep.keepPartitions(new Date())).toBe(false);
      expect(await parts.layout()).toMatchObject({ partitioned: false, pending: null });
    }
    // A keep set on a table that is not split cannot be applied: said as the job's error.
    delete process.env.ELYSIUM_TX_SPLIT_ENABLED;
    process.env.ELYSIUM_TX_KEEP_DAYS = '40';
    await expect(upkeep.keepPartitions(new Date())).rejects.toThrow('not split by day');
    delete process.env.ELYSIUM_TX_KEEP_DAYS;
    process.env.ELYSIUM_TX_SPLIT_ENABLED = 'true';
  });

  it('prepares, checks, splits two days ahead and makes the day tables, one step a pass', async () => {
    expect(await upkeep.keepPartitions(new Date())).toBe(true);
    expect((await parts.layout()).pending).toEqual({ cutMs: today + 2 * DAY_MS, validated: false });
    expect(await upkeep.keepPartitions(new Date())).toBe(true);
    expect((await parts.layout()).pending).toEqual({ cutMs: today + 2 * DAY_MS, validated: true });
    expect(await upkeep.keepPartitions(new Date())).toBe(false);
    expect(await names()).toEqual([LEGACY_PARTITION, partitionName(day(-2)), partitionName(day(-3))]);
    expect(await q(`SELECT count(*)::int AS n FROM elysium_tx`)).toEqual([{ n: 2 }]);
    // A day later the next day ahead gets its table.
    await upkeep.keepPartitions(new Date(Date.now() + DAY_MS));
    expect(await names()).toContain(partitionName(day(-4)));
  });

  it('a transaction dated after the bound is said by name, and a row with an absurd time never takes a prepared bound off', async () => {
    forgetSplitLayout();
    await unsplit();
    await wipeTables();
    await parts.prepare(today + 2 * DAY_MS);
    const absurd = await repo.insertTxs([tx({ block_time: '2099-01-01T00:00:00.000Z' })]).catch((e: unknown) => e);
    expect(pgErrorCode(absurd)).toBe('23514');
    expect((await parts.layout()).pending).toEqual({ cutMs: today + 2 * DAY_MS, validated: false });
    // One stored before any bound existed: the split is not started, and the job says why.
    await x(`ALTER TABLE elysium_tx DROP CONSTRAINT elysium_tx_split_bound`);
    await repo.insertTxs([tx({ block_time: new Date(today + 2 * DAY_MS + 5000).toISOString() })]);
    await expect(upkeep.keepPartitions(new Date())).rejects.toThrow('after the split bound');
    expect((await parts.layout()).pending).toBeNull();
    await wipeTables();
  });

  it('a bound left too close by a pass that could not finish is replaced by a later one', async () => {
    forgetSplitLayout();
    await unsplit();
    await parts.prepare(today + DAY_MS);
    // 20 hours before that bound it is still fine; 3 hours before, a new one is prepared.
    await upkeep.keepPartitions(new Date(today + 4 * 3_600_000));
    expect((await parts.layout()).pending).toEqual({ cutMs: today + DAY_MS, validated: true });
    await upkeep.keepPartitions(new Date(today + 21 * 3_600_000));
    expect((await parts.layout()).pending).toEqual({ cutMs: today + 2 * DAY_MS, validated: false });
    await prismaHistorical.$executeRawUnsafe(`ALTER TABLE elysium_tx DROP CONSTRAINT IF EXISTS elysium_tx_split_bound`);
  });
});
