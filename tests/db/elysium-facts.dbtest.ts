/**
 * What stands in for old transactions, on a real Postgres: the sender of a transaction copied
 * onto the rows read from its logs, the history facts folded one day at a time, the insert of
 * old rows that moves them itself, and the pages that read facts and elysium_tx together. Every
 * figure is compared with the one elysium_tx alone gives.
 */
jest.mock('../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../src/core/redis.service', () => ({ redisService: { getClient: () => ({}), get: async () => null, set: async () => undefined } }));

import { prismaHistoricalAggregate, prismaHistoricalPages, prismaHistoricalRead } from '../../src/core/prisma.historical.service';
import { cacheService } from '../../src/core/cache.service';
import { viewScheduler, ViewResult } from '../../src/core/viewScheduler';
import { ELYSIUM_PROJECTS } from '../../src/constants/elysium-projects';
import { ElysiumFactsRepository, PROJECT_FOLD_DAYS } from '../../src/repositories/prisma/prisma.elysium-facts.repository';
import { ElysiumIngestRepository } from '../../src/repositories/prisma/prisma.elysium.repository';
import { ElysiumAnalyticsService } from '../../src/services/elysium/elysium-analytics.service';
import { ElysiumEcosystemService } from '../../src/services/elysium/elysium-ecosystem.service';
import { FACTS_FINAL_DAYS } from '../../src/services/elysium/elysium-retention.util';
import { directoryContracts, ElysiumUpkeepService } from '../../src/services/elysium/elysium-upkeep.service';
import { A, H, disconnect, q, wipe, x, type TxFixture } from './helpers';

const repo = ElysiumIngestRepository.getInstance();
const facts = ElysiumFactsRepository.getInstance();
const analytics = ElysiumAnalyticsService.getInstance();
const ecosystem = ElysiumEcosystemService.getInstance() as unknown as {
  computeAllTime: () => Promise<Array<{ slug: string; txs: number; wallets: number; first_at: number | null }>>;
};
const DAY_MS = 86_400_000;
const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
/** The UTC day `n` days before today, and an instant in it. */
const day = (n: number): string => new Date(today - n * DAY_MS).toISOString().slice(0, 10);
const at = (n: number, seconds: number): string => new Date(today - n * DAY_MS + seconds * 1000).toISOString();

let seq = 0;
function tx(over: Partial<TxFixture> & { block_time: string; from_addr: string }): TxFixture {
  seq += 1;
  return {
    tx_hash: H(0x13_0000 + seq),
    block_number: String(1_000_000 + seq),
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

interface AddressProfile {
  topMethods: Array<{ methodId: string; name: string; txs: number }>;
  dex: { swaps: number; pools: number; swaps24h: number };
}
interface ContractProfile {
  usage: { firstCall: string | null; lastCall: string | null };
}

/** The six methods an address uses most, from elysium_tx alone (what the page read before the facts). */
async function rawTopMethods(address: string): Promise<Array<{ methodId: string; txs: number; creation: boolean }>> {
  const rows = await q<{ method_id: string | null; to_null: boolean; txs: number }>(
    `SELECT CASE WHEN to_addr IS NULL THEN NULL ELSE method_id END AS method_id, (to_addr IS NULL) AS to_null, count(*)::int AS txs
     FROM elysium_tx WHERE from_addr = $1 AND NOT is_spam
     GROUP BY 1, 2 ORDER BY txs DESC, 1 NULLS FIRST, 2 LIMIT 6`,
    address
  );
  return rows.map((r) => ({ methodId: r.to_null ? '' : (r.method_id ?? ''), txs: r.txs, creation: r.to_null }));
}
async function pageTopMethods(address: string): Promise<Array<{ methodId: string; txs: number; creation: boolean }>> {
  const profile = (await analytics.getAddress(address)) as AddressProfile;
  return profile.topMethods.map((m) => ({ methodId: m.methodId, txs: m.txs, creation: m.name === 'contract creation' }));
}
async function rawFirstLast(contract: string): Promise<{ first: string | null; last: string | null }> {
  const rows = await q<{ first: number | null; last: number | null }>(
    `SELECT (extract(epoch FROM min(block_time)) * 1000)::float8 AS first, (extract(epoch FROM max(block_time)) * 1000)::float8 AS last
     FROM elysium_tx WHERE to_addr = $1`,
    contract
  );
  const iso = (v: number | null): string | null => (v === null ? null : new Date(Number(v)).toISOString());
  return { first: iso(rows[0].first), last: iso(rows[0].last) };
}
async function pageFirstLast(contract: string): Promise<{ first: string | null; last: string | null }> {
  const profile = (await analytics.getContract(contract)) as ContractProfile;
  return { first: profile.usage.firstCall, last: profile.usage.lastCall };
}
/** Per project since the first block, from elysium_tx alone. */
async function rawAllTime(): Promise<Array<{ slug: string; txs: number; wallets: number; first_at: number | null }>> {
  const pairs = ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => ({ slug: p.slug, addr: c.address })));
  return q(
    `SELECT slug, sum(txs)::int AS txs, count(*)::int AS wallets, extract(epoch FROM min(first_at))::float8 AS first_at
     FROM (
       SELECT reg.slug, t.from_addr, count(*) AS txs, min(t.block_time) AS first_at
       FROM jsonb_to_recordset($1::jsonb) AS reg(slug text, addr text)
       JOIN elysium_tx t ON t.to_addr = reg.addr
       WHERE NOT t.is_spam
       GROUP BY reg.slug, t.from_addr
     ) s GROUP BY slug ORDER BY slug`,
    JSON.stringify(pairs)
  );
}
const bySlug = <T extends { slug: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.slug.localeCompare(b.slug));

beforeAll(async () => {
  await wipe();
  // The pages are computed on each call here: no cache, no scheduler.
  jest.spyOn(cacheService, 'getOrRefresh').mockImplementation(((_key: string, fn: () => Promise<unknown>) => fn()) as never);
  jest.spyOn(cacheService, 'getOrSet').mockImplementation(((_key: string, fn: () => Promise<unknown>) => fn()) as never);
  jest.spyOn(viewScheduler, 'read').mockImplementation((async (def: { compute: () => Promise<unknown> }) =>
    new ViewResult(await def.compute(), new Date().toISOString(), 0)) as never);
  jest.spyOn(viewScheduler, 'watch').mockImplementation(() => undefined);
});
afterAll(async () => {
  await wipe();
  await Promise.all([prismaHistoricalAggregate.$disconnect(), prismaHistoricalPages.$disconnect(), prismaHistoricalRead.$disconnect()]);
  await disconnect();
});

describe("the transaction's sender on the rows read from its logs", () => {
  const sender = A(0x5e1);
  // Ten minutes ago: inside the hours a page looks at for swaps whose sender is not copied yet.
  const whenMs = Math.floor((Date.now() - 600_000) / 1000) * 1000;
  const when = new Date(whenMs).toISOString();
  const txWithLogs = tx({ block_time: when, from_addr: sender });

  beforeAll(async () => {
    await wipe();
    await repo.insertTxs([txWithLogs]);
    const swap = (hash: string, log: number, time: string): string =>
      `('${hash}', ${log}, '${A(0x9001)}', 'v2', '${time}', 1, '${A(0x77)}', '${A(0x78)}', 1, -1)`;
    await x(
      `INSERT INTO elysium_dex_swap (tx_hash, log_index, pool, version, block_time, block_number, sender, recipient, amount0, amount1)
       VALUES ${swap(txWithLogs.tx_hash, 0, when)}, ${swap(txWithLogs.tx_hash, 1, when)},
              ${swap(H(0xdead01), 0, when)},
              ${swap(txWithLogs.tx_hash, 2, new Date(whenMs + 1000).toISOString())}`
    );
    const trade = (hash: string, log: number, trader: string | null): string =>
      `('${hash}', ${log}, '${A(0x7001)}', 'v4', '${when}', 1, ${trader ? `'${trader}'` : 'NULL'}, true, 1, 1, 1)`;
    await x(
      `INSERT INTO elysium_launch_trade (tx_hash, log_index, token, venue, block_time, block_number, trader, is_buy, quote_amount, token_amount, price)
       VALUES ${trade(txWithLogs.tx_hash, 10, null)}, ${trade(txWithLogs.tx_hash, 11, A(0x7ade))}, ${trade(H(0xdead02), 0, null)}`
    );
    const launch = (token: string, hash: string, creator: string | null): string =>
      `('${token}', 'signal', 'curve', ${creator ? `'${creator}'` : 'NULL'}, '${when}', 1, '${hash}', '${A(0xee)}')`;
    await x(
      `INSERT INTO elysium_launch (token, launchpad, kind, creator, created_at, block_number, tx_hash, quote)
       VALUES ${launch(A(0x7001), txWithLogs.tx_hash, null)}, ${launch(A(0x7002), txWithLogs.tx_hash, A(0xc4ea))}, ${launch(A(0x7003), H(0xdead03), null)}`
    );
  });

  it('is copied where the transaction is held, at the same time; a row that names its own trader or creator is left alone', async () => {
    const copied = await facts.copyTxSenders(new Date(today - DAY_MS), new Date(today + DAY_MS));
    expect(copied).toEqual({ swaps: 3, trades: 1, launches: 1 });
    expect(await q(`SELECT log_index, tx_from FROM elysium_dex_swap ORDER BY tx_hash, log_index`)).toEqual(
      expect.arrayContaining([
        { log_index: 0, tx_from: sender },
        { log_index: 1, tx_from: sender },
        // Read from the log with another time than the transaction now has (the chain put it in
        // another block and the daily comparison moved it): still its swap.
        { log_index: 2, tx_from: sender },
      ])
    );
    expect(await q(`SELECT tx_from FROM elysium_dex_swap WHERE tx_hash = $1`, H(0xdead01))).toEqual([{ tx_from: null }]);
    expect(await q(`SELECT log_index, tx_from FROM elysium_launch_trade ORDER BY tx_hash, log_index`)).toEqual(
      expect.arrayContaining([
        { log_index: 10, tx_from: sender },
        { log_index: 11, tx_from: null },
      ])
    );
    expect(await q(`SELECT token, tx_from FROM elysium_launch ORDER BY token`)).toEqual([
      { token: A(0x7001), tx_from: sender },
      { token: A(0x7002), tx_from: null },
      { token: A(0x7003), tx_from: null },
    ]);
  });

  it('a second pass copies nothing more, and a span that holds none of the rows touches none', async () => {
    expect(await facts.copyTxSenders(new Date(today - DAY_MS), new Date(today + DAY_MS))).toEqual({ swaps: 0, trades: 0, launches: 0 });
    await x(`UPDATE elysium_dex_swap SET tx_from = NULL`);
    expect(await facts.copyTxSenders(new Date(today - 3 * DAY_MS), new Date(today - 2 * DAY_MS))).toEqual({ swaps: 0, trades: 0, launches: 0 });
    expect(await facts.copyTxSenders(new Date(today - DAY_MS), new Date(today + DAY_MS))).toMatchObject({ swaps: 3 });
  });

  it("an address's swaps are the same before the copy has been through the history, and after", async () => {
    const swapsOf = async (): Promise<AddressProfile['dex']> => ((await analytics.getAddress(sender)) as AddressProfile).dex;
    // No row for the copy yet: the page goes through elysium_tx.
    await x(`UPDATE elysium_dex_swap SET tx_from = NULL`);
    await x(`DELETE FROM elysium_ingest_state WHERE stream = 'txsender'`);
    expect(await swapsOf()).toEqual({ swaps: 3, pools: 1, swaps24h: 3 });
    // History copied, and these recent swaps not yet: still found, through the transactions of the last hours.
    await repo.advance('txsender', { cursor: new Date(), backfillDone: true });
    expect(await swapsOf()).toEqual({ swaps: 3, pools: 1, swaps24h: 3 });
    await facts.copyTxSenders(new Date(today - DAY_MS), new Date(today + DAY_MS));
    expect(await swapsOf()).toEqual({ swaps: 3, pools: 1, swaps24h: 3 });
  });
});

describe("the sender of transactions that arrive long after their logs", () => {
  const sender = A(0x5e3);
  const swapAt = (hash: string, time: string): Promise<number> =>
    x(
      `INSERT INTO elysium_dex_swap (tx_hash, log_index, pool, version, block_time, block_number, sender, recipient, amount0, amount1)
       VALUES ($1, 0, $2, 'v2', $3::timestamptz, 1, $4, $4, 1, -1)`,
      hash,
      A(0x9002),
      time,
      A(0x79)
    );

  beforeAll(wipe);

  it('a page of old transactions gives the swaps read from their logs a sender, whether it stores them or finds them stored', async () => {
    const old = tx({ block_time: at(30, 500), from_addr: sender });
    await swapAt(old.tx_hash, old.block_time);
    expect((await repo.insertTxs([old])).inserted).toBe(1);
    expect(await q(`SELECT tx_from FROM elysium_dex_swap WHERE tx_hash = $1`, old.tx_hash)).toEqual([{ tx_from: sender }]);
    // Read again after the copy had failed the first time: nothing to store, the sender still to copy.
    await x(`UPDATE elysium_dex_swap SET tx_from = NULL`);
    expect((await repo.insertTxs([old])).inserted).toBe(0);
    expect(await q(`SELECT tx_from FROM elysium_dex_swap WHERE tx_hash = $1`, old.tx_hash)).toEqual([{ tx_from: sender }]);
  });

  it('the copy goes from where it stopped to where the tx stream stands, however far that is, and is done only once that stream has been through the history', async () => {
    const upkeep = ElysiumUpkeepService.getInstance() as unknown as {
      copySenders: (now: Date, tx: { cursor: Date | null; backfillDone: boolean } | null) => Promise<boolean>;
    };
    await wipe();
    // The tx stream stood still for 20 days while the swaps kept arriving, then read them all at once.
    const rows = [18, 12, 6, 1].map((n) => tx({ block_time: at(n, 900), from_addr: sender }));
    for (const r of rows) await swapAt(r.tx_hash, r.block_time);
    await x(
      `INSERT INTO elysium_tx (tx_hash, block_number, block_time, from_addr, to_addr, gas_used, fee_wei, success, is_spam)
       SELECT tx_hash, block_number, block_time, from_addr, to_addr, 1, 1, true, false
       FROM jsonb_to_recordset($1::jsonb) AS r(tx_hash text, block_number bigint, block_time timestamptz, from_addr text, to_addr text)`,
      JSON.stringify(rows)
    );
    await repo.advance('txsender', { cursor: new Date(today - 20 * DAY_MS), backfillDone: true });
    const now = new Date();
    let passes = 0;
    while ((await upkeep.copySenders(now, { cursor: now, backfillDone: true })) && passes < 30) passes += 1;
    expect(await q(`SELECT count(*)::int AS n FROM elysium_dex_swap WHERE tx_from = $1`, sender)).toEqual([{ n: 4 }]);

    // A database whose tx stream is still loading the chain's history: the copy follows it, and does not say it is done.
    await x(`DELETE FROM elysium_ingest_state WHERE stream = 'txsender'`);
    await x(`UPDATE elysium_dex_swap SET tx_from = NULL`);
    const early = new Date(today - 15 * DAY_MS);
    while ((await upkeep.copySenders(now, { cursor: early, backfillDone: false })) && passes < 200) passes += 1;
    expect(await q(`SELECT backfill_done FROM elysium_ingest_state WHERE stream = 'txsender'`)).toEqual([{ backfill_done: false }]);
    expect(await q(`SELECT count(*)::int AS n FROM elysium_dex_swap WHERE tx_from = $1`, sender)).toEqual([{ n: 1 }]);
    while ((await upkeep.copySenders(now, { cursor: now, backfillDone: true })) && passes < 400) passes += 1;
    expect(await q(`SELECT backfill_done FROM elysium_ingest_state WHERE stream = 'txsender'`)).toEqual([{ backfill_done: true }]);
    expect(await q(`SELECT count(*)::int AS n FROM elysium_dex_swap WHERE tx_from = $1`, sender)).toEqual([{ n: 4 }]);
  });
});

describe('the history facts', () => {
  const alice = A(0xa11ce);
  const bob = A(0xb0b);
  const target = A(0xc0);
  const other = A(0xc1);
  const D = FACTS_FINAL_DAYS + 5; // days ago: the first day of this history

  beforeAll(async () => {
    await wipe();
    await facts.ensureState();
    const rows: TxFixture[] = [];
    // Five final days, then days up to today; alice calls two methods, transfers, creates; bob spams.
    for (let n = D; n >= 0; n--) {
      rows.push(tx({ block_time: at(n, 100), from_addr: alice, to_addr: target, method_id: '0xaaaaaaaa' }));
      rows.push(tx({ block_time: at(n, 200), from_addr: alice, to_addr: target, method_id: '0xbbbbbbbb' }));
      if (n % 2 === 0) rows.push(tx({ block_time: at(n, 300), from_addr: alice, to_addr: other, method_id: null }));
      if (n % 3 === 0) rows.push(tx({ block_time: at(n, 400), from_addr: alice, to_addr: null, method_id: '0x60806040', contract_address: A(0xdd00 + n) }));
      rows.push(tx({ block_time: at(n, 50), from_addr: bob, to_addr: target, method_id: '0xcccccccc', is_spam: true }));
      rows.push(tx({ block_time: at(n, 500), from_addr: bob, to_addr: other, method_id: '0xaaaaaaaa' }));
    }
    // The old path would take the facts' lock for each of these pages; they are stored before any fold here.
    await repo.insertTxs(rows);
  });

  it('before any fold the pages read elysium_tx alone', async () => {
    expect(await pageTopMethods(alice)).toEqual(await rawTopMethods(alice));
    expect(await pageFirstLast(target)).toEqual(await rawFirstLast(target));
    expect(await pageFirstLast(A(0xdead))).toEqual({ first: null, last: null });
  });

  it('a day is folded once, in order, and the pages stay the same after each', async () => {
    expect(await facts.firstTxDay()).toBe(day(D));
    // Not the first day while nothing is folded: refused.
    expect(await facts.foldHistoryDay(day(D - 1), false)).toBe('moved');
    expect(await facts.foldHistoryDay(day(D), true)).toBe('folded');
    // The same day again, by another process: refused, nothing added twice.
    expect(await facts.foldHistoryDay(day(D), true)).toBe('moved');
    expect(await facts.foldHistoryDay(day(D), false)).toBe('moved');
    expect(await facts.foldHistoryDay(day(D - 2), false)).toBe('moved');
    for (const n of [D - 1, D - 2, D - 3]) {
      expect(await facts.foldHistoryDay(day(n), false)).toBe('folded');
      expect(await pageTopMethods(alice)).toEqual(await rawTopMethods(alice));
      expect(await pageTopMethods(bob)).toEqual(await rawTopMethods(bob));
      expect(await pageFirstLast(target)).toEqual(await rawFirstLast(target));
      expect(await pageFirstLast(other)).toEqual(await rawFirstLast(other));
    }
    expect((await facts.standing([])).history).toBe(day(D - 3));
    // The spam sender's calls are in no method count, and its target's first call is the spam one.
    expect(await q(`SELECT method_key, txs::int AS txs FROM elysium_address_method WHERE address = $1 ORDER BY 1`, bob)).toEqual([{ method_key: '0xaaaaaaaa', txs: 4 }]);
    expect((await rawFirstLast(target)).first).toBe(at(D, 50));
  });

  it('the facts hold what the folded days hold: methods by kind, first and last call', async () => {
    const methods = await q<{ method_key: string; txs: number }>(`SELECT method_key, txs::int AS txs FROM elysium_address_method WHERE address = $1 ORDER BY 1`, alice);
    const folded = [D, D - 1, D - 2, D - 3];
    expect(methods).toEqual(
      [
        { method_key: '', txs: folded.filter((n) => n % 2 === 0).length },
        { method_key: '0xaaaaaaaa', txs: 4 },
        { method_key: '0xbbbbbbbb', txs: 4 },
        { method_key: 'create', txs: folded.filter((n) => n % 3 === 0).length },
      ].filter((m) => m.txs > 0)
    );
    const seen = await q<{ first: string; last: string }>(
      `SELECT to_char(first_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first,
              to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last
       FROM elysium_target_seen WHERE to_addr = $1`,
      target
    );
    expect(seen).toEqual([{ first: at(D, 50), last: at(D - 3, 200) }]);
  });

  it('old rows stored after their day was folded are added to the facts by their own insert, once', async () => {
    const carol = A(0xca701);
    const late = [
      // In folded days: a new method for alice, a creation, a transfer, a spam row, an earlier first call.
      tx({ block_time: at(D - 1, 900), from_addr: alice, to_addr: target, method_id: '0xdddddddd' }),
      tx({ block_time: at(D - 1, 901), from_addr: alice, to_addr: target, method_id: '0xdddddddd' }),
      tx({ block_time: at(D - 2, 902), from_addr: alice, to_addr: null, method_id: '0x60806040', contract_address: A(0xddff) }),
      tx({ block_time: at(D - 2, 903), from_addr: carol, to_addr: other, method_id: null }),
      tx({ block_time: at(D - 2, 904), from_addr: carol, to_addr: other, method_id: '0xeeeeeeee', is_spam: true }),
      tx({ block_time: at(D, 1), from_addr: carol, to_addr: target, method_id: '0xeeeeeeee' }),
      // In a day old enough for the same path, not folded yet: left to its fold.
      tx({ block_time: at(D - 4, 905), from_addr: carol, to_addr: target, method_id: '0xffffffff' }),
      // And a row of today.
      tx({ block_time: at(0, 30), from_addr: carol, to_addr: target, method_id: '0xffffffff' }),
    ];
    expect((await repo.insertTxs(late)).inserted).toBe(8);
    const check = async (): Promise<void> => {
      for (const who of [alice, bob, carol]) expect(await pageTopMethods(who)).toEqual(await rawTopMethods(who));
      for (const c of [target, other]) expect(await pageFirstLast(c)).toEqual(await rawFirstLast(c));
    };
    await check();
    expect((await rawFirstLast(target)).first).toBe(at(D, 1));
    // The same page read again by the provider's stream: nothing stored, nothing added.
    expect((await repo.insertTxs(late)).inserted).toBe(0);
    await check();
    // The day that was not folded yet now is: its late row is counted by the fold, not twice.
    expect(await facts.foldHistoryDay(day(D - 4), false)).toBe('folded');
    await check();
    expect(await q(`SELECT txs::int AS txs FROM elysium_address_method WHERE address = $1 AND method_key = '0xffffffff'`, carol)).toEqual([{ txs: 1 }]);
  });

  it('a fold and inserts of old rows at the same time count every transaction once', async () => {
    const dave = A(0xda7e);
    // The next days to fold, each with pages of old rows arriving while it is folded.
    for (const n of [D - 5, D - 6]) {
      if (n < FACTS_FINAL_DAYS - 1) break;
      const pages = Array.from({ length: 6 }, (_, p) =>
        Array.from({ length: 20 }, (_, i) => tx({ block_time: at(n, 1000 + p * 20 + i), from_addr: dave, to_addr: target, method_id: '0x12345678' }))
      );
      await Promise.all([facts.foldHistoryDay(day(n), false), ...pages.map((page) => repo.insertTxs(page))]);
      expect(await pageTopMethods(dave)).toEqual(await rawTopMethods(dave));
      expect(await pageFirstLast(target)).toEqual(await rawFirstLast(target));
    }
    const raw = await q<{ n: number }>(`SELECT count(*)::int AS n FROM elysium_tx WHERE from_addr = $1`, dave);
    expect(raw[0].n).toBeGreaterThan(0);
    // Whatever the fold took and whatever the inserts added themselves, together they are the folded days' rows.
    const through = (await facts.standing([])).history as string;
    const folded = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM elysium_tx WHERE from_addr = $1 AND block_time < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')`,
      dave,
      through
    );
    expect(await q(`SELECT COALESCE(sum(txs), 0)::int AS n FROM elysium_address_method WHERE address = $1`, dave)).toEqual([{ n: folded[0].n }]);
  });
});

describe("the directory's contracts", () => {
  const contracts = directoryContracts();
  const [c0, c1, c2] = contracts;
  const slugOf = (addr: string): string => ELYSIUM_PROJECTS.find((p) => p.contracts.some((c) => c.address === addr))!.slug;
  const D = FACTS_FINAL_DAYS + PROJECT_FOLD_DAYS + 3; // days ago: the first day of this history
  const upTo = day(FACTS_FINAL_DAYS);
  const compare = async (): Promise<void> => {
    const want = await rawAllTime();
    const got = bySlug(await ecosystem.computeAllTime());
    expect(got.map((r) => ({ ...r, first_at: r.first_at === null ? null : Number(r.first_at) }))).toEqual(
      want.map((r) => ({ ...r, first_at: r.first_at === null ? null : Number(r.first_at) }))
    );
  };

  beforeAll(async () => {
    await wipe();
    await facts.ensureState();
    const rows: TxFixture[] = [];
    for (let n = D; n >= 0; n--) {
      for (let w = 0; w < 4; w++) {
        // Wallet w calls c0 every day, c1 every other day; wallet 0 also calls c2 (another project, or the same).
        rows.push(tx({ block_time: at(n, 100 + w), from_addr: A(0x3000 + w), to_addr: c0 }));
        if (n % 2 === 0) rows.push(tx({ block_time: at(n, 200 + w), from_addr: A(0x3000 + w), to_addr: c1 }));
      }
      rows.push(tx({ block_time: at(n, 300), from_addr: A(0x3000), to_addr: c2 }));
      rows.push(tx({ block_time: at(n, 310), from_addr: A(0x3999), to_addr: c0, is_spam: true }));
      rows.push(tx({ block_time: at(n, 320), from_addr: A(0x3000), to_addr: A(0xc0ffee) }));
    }
    for (let i = 0; i < rows.length; i += 500) await repo.insertTxs(rows.slice(i, i + 500));
  });

  it('are read from elysium_tx alone until they are folded', async () => {
    await compare();
    await facts.registerProjectContracts(contracts);
    expect(await facts.standing(contracts)).toMatchObject({ projects: contracts.length, projectsThrough: null });
    await compare();
  });

  it('are folded a week at a time up to the final day, the page the same at every step', async () => {
    const first = (await facts.firstTxDay()) as string;
    const one = await facts.foldProjectContracts(contracts, upTo, first);
    expect(one).toEqual({ moved: contracts.length, behind: true });
    expect((await facts.standing(contracts)).projectsThrough).toBe(day(D - (PROJECT_FOLD_DAYS - 1)));
    await compare();
    const two = await facts.foldProjectContracts(contracts, upTo, first);
    expect(two).toEqual({ moved: contracts.length, behind: false });
    expect((await facts.standing(contracts)).projectsThrough).toBe(upTo);
    await compare();
    // Up to date: a further pass moves nothing.
    expect(await facts.foldProjectContracts(contracts, upTo, first)).toEqual({ moved: 0, behind: false });
    const wallets = await q<{ txs: number }>(`SELECT txs::int AS txs FROM elysium_project_wallet WHERE to_addr = $1 AND from_addr = $2`, c0, A(0x3001));
    expect(wallets).toEqual([{ txs: D - FACTS_FINAL_DAYS + 1 }]);
    // No spam sender, no contract outside the directory.
    expect(await q(`SELECT 1 FROM elysium_project_wallet WHERE from_addr = $1 OR to_addr = $2`, A(0x3999), A(0xc0ffee))).toEqual([]);
  });

  it('old rows stored after the fold reach the wallets through their insert, the others through elysium_tx', async () => {
    const late = [
      tx({ block_time: at(D - 1, 700), from_addr: A(0x3777), to_addr: c0 }),
      tx({ block_time: at(D, 1), from_addr: A(0x3777), to_addr: c1 }),
      tx({ block_time: at(D - 1, 701), from_addr: A(0x3777), to_addr: c0, is_spam: true }),
      tx({ block_time: at(FACTS_FINAL_DAYS - 1, 702), from_addr: A(0x3777), to_addr: c0 }),
      tx({ block_time: at(0, 20), from_addr: A(0x3778), to_addr: c0 }),
    ];
    expect((await repo.insertTxs(late)).inserted).toBe(5);
    await compare();
    expect((await repo.insertTxs(late)).inserted).toBe(0);
    await compare();
    expect(await q(`SELECT to_addr, txs::int AS txs FROM elysium_project_wallet WHERE from_addr = $1 ORDER BY 1`, A(0x3777))).toEqual(
      [
        { to_addr: c0, txs: 1 },
        { to_addr: c1, txs: 1 },
      ].sort((a, b) => a.to_addr.localeCompare(b.to_addr))
    );
  });

  it('a contract listed later starts from its own history, beside the ones already folded', async () => {
    await x(`DELETE FROM elysium_project_wallet WHERE to_addr = $1`, c1);
    await x(`DELETE FROM elysium_project_contract WHERE to_addr = $1`, c1);
    await compare();
    await facts.registerProjectContracts(contracts);
    expect((await facts.standing(contracts)).projectsThrough).toBeNull();
    await compare();
    const first = (await facts.firstTxDay()) as string;
    expect(await facts.foldProjectContracts(contracts, upTo, first)).toEqual({ moved: 1, behind: true });
    await compare();
    expect(await facts.foldProjectContracts(contracts, upTo, first)).toEqual({ moved: 1, behind: false });
    expect((await facts.standing(contracts)).projectsThrough).toBe(upTo);
    await compare();
    expect(slugOf(c1)).toBeTruthy();
  });
});

describe('the upkeep pass', () => {
  const upkeep = ElysiumUpkeepService.getInstance();
  const D = FACTS_FINAL_DAYS + 4;
  const alice = A(0xa11ce);

  beforeAll(async () => {
    await wipe();
    const rows: TxFixture[] = [];
    for (let n = D; n >= 0; n--) rows.push(tx({ block_time: at(n, 100), from_addr: alice, to_addr: directoryContracts()[0] }));
    await repo.insertTxs(rows);
  });

  it('folds nothing while the tx stream is still loading its history', async () => {
    await repo.advance('tx', { cursor: new Date(), backfillDone: false });
    await x(`UPDATE elysium_ingest_state SET backfill_done = false WHERE stream = 'tx'`);
    await upkeep.tick();
    expect((await facts.standing(directoryContracts())).history).toBeNull();
  });

  it('then goes through the history, records where each job stands, and leaves the pages as they were', async () => {
    await repo.advance('tx', { cursor: new Date(), backfillDone: true });
    let passes = 0;
    while ((await upkeep.tick()) <= 5_000 && passes < 50) passes += 1;
    const standing = await facts.standing(directoryContracts());
    expect(standing.history).toBe(day(FACTS_FINAL_DAYS));
    expect(standing.projectsThrough).toBe(day(FACTS_FINAL_DAYS));
    const states = await q<{ stream: string; backfill_done: boolean; last_error: string | null; cursor_day: string | null }>(
      `SELECT stream, backfill_done, last_error, ((cursor AT TIME ZONE 'UTC')::date)::text AS cursor_day
       FROM elysium_ingest_state WHERE stream IN ('txsender', 'facts') ORDER BY stream`
    );
    expect(states).toEqual([
      // The end of the last day every fact holds.
      { stream: 'facts', backfill_done: true, last_error: null, cursor_day: day(FACTS_FINAL_DAYS - 1) },
      { stream: 'txsender', backfill_done: true, last_error: null, cursor_day: day(0) },
    ]);
    expect(await pageTopMethods(alice)).toEqual(await rawTopMethods(alice));
    expect(bySlug(await ecosystem.computeAllTime()).map((r) => [r.slug, r.txs, r.wallets])).toEqual((await rawAllTime()).map((r) => [r.slug, r.txs, r.wallets]));
  });

  it('a job that fails is recorded under its own name and the other still runs', async () => {
    const spy = jest.spyOn(facts, 'copyTxSenders').mockRejectedValueOnce(new Error('copy failed for the test'));
    await upkeep.tick();
    spy.mockRestore();
    const states = await q<{ stream: string; last_error: string | null }>(
      `SELECT stream, last_error FROM elysium_ingest_state WHERE stream IN ('txsender', 'facts') ORDER BY stream`
    );
    expect(states).toEqual([
      { stream: 'facts', last_error: null },
      { stream: 'txsender', last_error: 'copy failed for the test' },
    ]);
    await upkeep.tick();
    expect(await q(`SELECT last_error FROM elysium_ingest_state WHERE stream = 'txsender'`)).toEqual([{ last_error: null }]);
  });
});
