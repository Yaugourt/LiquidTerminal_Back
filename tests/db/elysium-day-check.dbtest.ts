/**
 * The daily check on a real Postgres, with a provider served from memory. A day is stored
 * whole (the truth), then stored damaged in every way the check repairs, at once:
 *   - a hole of 40 minutes (rows the provider lists and we lack);
 *   - rows whose spam flag, outcome and gas the provider changed since, and one the chain moved
 *     to another block;
 *   - transactions the provider no longer lists (a reorganisation), one of which created a
 *     contract, one a launch with trades, one that left a pool swap and a live row.
 * The check has to bring every table back to what storing the whole day gives, and to remove
 * nothing before the provider said "not found" twice, 10 minutes apart.
 */
jest.mock('../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import { ElysiumIngestRepository } from '../../src/repositories/prisma/prisma.elysium.repository';
import { ElysiumDayCheckService } from '../../src/services/elysium/elysium-day-check.service';
import { IngestRejects } from '../../src/services/elysium/elysium-ingest-rejects';
import { A, H, disconnect, q, wipe, x, type TxFixture } from './helpers';

const MIN = 60_000;
const repo = ElysiumIngestRepository.getInstance();

// A closed day, three days ago: one transaction every 20 s, 12 senders, some spam, some
// bridge-driven, some contract creations.
const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 3 * 86_400_000;
const day = new Date(dayStart).toISOString().slice(0, 10);
const truth: TxFixture[] = Array.from({ length: 4320 }, (_, i) => {
  const sender = A(1 + (i % 12));
  const creation = i % 211 === 5;
  return {
    tx_hash: H(1000 + i),
    block_number: String(50_000 + i),
    block_time: new Date(dayStart + i * 20_000).toISOString(),
    from_addr: sender,
    to_addr: creation ? null : A(500 + (i % 7)),
    contract_address: creation ? A(9000 + i) : null,
    method_id: creation ? null : '0xa9059cbb',
    tx_type: i % 53 === 0 ? '0x64' : '0x2',
    gas_used: String(21000 + i),
    fee_wei: String((21000 + i) * 3),
    success: i % 31 !== 0,
    // Sender 12 only ever sends spam.
    is_spam: i % 97 === 0 || sender === A(12),
  };
});
const counts = {
  txs: truth.filter((t) => !t.is_spam).length,
  spam: truth.filter((t) => t.is_spam).length,
  bridge: truth.filter((t) => !t.is_spam && t.tx_type === '0x64').length,
};
const holeFrom = dayStart + 13 * 3_600_000 + 5 * MIN;
const inHole = (t: TxFixture): boolean => Date.parse(t.block_time) >= holeFrom && Date.parse(t.block_time) < holeFrom + 40 * MIN;
const orphanAt = (hour: number): string => new Date(dayStart + hour * 3_600_000 + 7_000).toISOString();
const orphans: TxFixture[] = [
  { tx_hash: H(900_001), block_number: '70001', block_time: orphanAt(3), from_addr: A(77), to_addr: A(501), contract_address: null, method_id: '0xa9059cbb', tx_type: '0x2', gas_used: '21000', fee_wei: '63000', success: true, is_spam: false },
  { tx_hash: H(900_002), block_number: '70002', block_time: orphanAt(9), from_addr: A(3), to_addr: null, contract_address: A(8888), method_id: null, tx_type: '0x2', gas_used: '900000', fee_wei: '2700000', success: true, is_spam: false },
  { tx_hash: H(900_003), block_number: '70003', block_time: orphanAt(20), from_addr: A(4), to_addr: A(502), contract_address: null, method_id: '0xdeadbeef', tx_type: '0x2', gas_used: '300000', fee_wei: '900000', success: true, is_spam: false },
];

const insertAll = async (rows: TxFixture[]): Promise<void> => {
  for (let i = 0; i < rows.length; i += 1000) await repo.insertTxs(rows.slice(i, i + 1000));
};
const launch = (token: string, curve: string, tx: TxFixture, name: string) => ({
  token, launchpad: 'CorePad' as const, kind: 'curve' as const, creator: tx.from_addr, created_at: tx.block_time,
  block_number: tx.block_number, tx_hash: tx.tx_hash, curve, pool: null, quote: A(0), name, symbol: name.toUpperCase(),
});
const trade = (t: TxFixture, log: number, token: string, price: number, amount: string) => ({
  tx_hash: t.tx_hash, log_index: log, token, venue: 'curve' as const, block_time: t.block_time, block_number: t.block_number,
  trader: t.from_addr, is_buy: true, quote_amount: '1000', token_amount: amount, price,
});
const snapshot = async (): Promise<Record<string, string>> => ({
  tx: JSON.stringify(await q(`SELECT tx_hash, block_number::text, (extract(epoch FROM block_time) * 1000)::float8 AS at, from_addr, to_addr, contract_address, gas_used::text, fee_wei::text, success, is_spam FROM elysium_tx ORDER BY tx_hash`)),
  address_day: JSON.stringify(await q(`SELECT address, day::text, tx_count FROM elysium_address_day ORDER BY address, day`)),
  address: JSON.stringify(await q(`SELECT address, (extract(epoch FROM first_seen) * 1000)::float8 AS first_seen, first_day::text FROM elysium_address ORDER BY address`)),
  contract: JSON.stringify(await q(`SELECT address, deployer, deploy_tx, block_number::text FROM elysium_contract ORDER BY address`)),
  live: JSON.stringify(await q(`SELECT tx_hash FROM elysium_tx_live ORDER BY tx_hash`)),
  dex: JSON.stringify([await q(`SELECT pool FROM elysium_dex_pool ORDER BY pool`), await q(`SELECT tx_hash, log_index FROM elysium_dex_swap ORDER BY 1, 2`)]),
  launch: JSON.stringify([await q(`SELECT token, last_price, last_block::text, curve_sold::text FROM elysium_launch ORDER BY token`), await q(`SELECT tx_hash, log_index FROM elysium_launch_trade ORDER BY 1, 2`)]),
});

describe('the daily check, on a real database', () => {
  let skew = 0;
  const realNow = Date.now.bind(Date);
  let expected: Record<string, string>;
  let lookups = 0;
  let slotsAsked = 0;
  const rejects = new IngestRejects();
  const listed = new Map(truth.map((t) => [t.tx_hash, t]));
  const svc = new ElysiumDayCheckService({
    ensureRunning: () => undefined,
    wait: async () => undefined,
    head: async () => new Date(),
    txCursor: async () => new Date(),
    fetchDaily: async () => [{ day, ...counts }],
    pageTxs: async (start, end, onPage) => {
      slotsAsked++;
      // As the provider: both bounds inclusive, to the second, pages of 1,000.
      const rows = truth.filter((t) => Date.parse(t.block_time) >= start.getTime() && Math.floor(Date.parse(t.block_time) / 1000) * 1000 <= end.getTime());
      for (let i = 0; i < Math.max(1, rows.length); i += 1000) await onPage(rows.slice(i, i + 1000));
    },
    insertTxs: async (rows) => (await repo.insertTxs(rows)).inserted,
    txListed: async (hash) => {
      lookups++;
      return listed.has(hash);
    },
    rejects,
  });
  const status = async (): Promise<Record<string, unknown>> =>
    (await q(`SELECT status, our_txs, our_spam, rereads, rows_added, rows_corrected, rows_removed, repaired_at IS NOT NULL AS repaired FROM elysium_day_check WHERE day = $1::date`, day))[0];

  beforeAll(async () => {
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    // 1. The whole day, through the stream's own insert: what every table must hold at the end.
    await wipe();
    await insertAll(truth);
    await repo.insertLaunches([launch(A(7001), A(7002), truth[100], 'Kept')]);
    await repo.insertLaunchTrades([trade(truth[200], 0, A(7001), 0.001, '500'), trade(truth[300], 0, A(7001), 0.002, '700')]);
    expected = await snapshot();

    // 2. The same day, damaged.
    await wipe();
    const wrong = new Set([10, 1500, 2500, 11, 3000, 700].map((i) => truth[i].tx_hash));
    const damaged = truth.filter((t) => !inHole(t)).map((t) => {
      if (!wrong.has(t.tx_hash)) return t;
      // First read differently: gas not yet known, the outcome the other way, another block 50 minutes later, or the spam flag the other way.
      if (t.tx_hash === truth[3000].tx_hash) return { ...t, gas_used: '0', fee_wei: '0' };
      if (t.tx_hash === truth[2500].tx_hash) return { ...t, success: !t.success };
      if (t.tx_hash === truth[700].tx_hash) return { ...t, block_number: String(Number(t.block_number) + 99), block_time: new Date(Date.parse(t.block_time) + 50 * MIN).toISOString() };
      return { ...t, is_spam: !t.is_spam };
    });
    await insertAll([...damaged, ...orphans].sort((a, b) => a.block_time.localeCompare(b.block_time)));
    // What the dropped transactions left in the log tables: a launch of their own, the newest trade of a kept launch, a pool and a swap, a live row.
    await repo.insertLaunches([launch(A(7001), A(7002), truth[100], 'Kept'), launch(A(7777), A(7778), orphans[2], 'Gone')]);
    await repo.insertLaunchTrades([
      trade(truth[200], 0, A(7001), 0.001, '500'),
      trade(truth[300], 0, A(7001), 0.002, '700'),
      trade(orphans[2], 4, A(7001), 0.009, '9000'),
      trade(orphans[2], 5, A(7777), 0.5, '10'),
    ]);
    await repo.insertDexPools([{ pool: A(6001), factory: A(6000), version: 'v2', token0: A(1), token1: A(2), fee: null, created_at: orphans[1].block_time, block_number: '70002', tx_hash: orphans[1].tx_hash }]);
    await repo.insertDexSwaps([{ tx_hash: orphans[0].tx_hash, log_index: 1, pool: A(6001), version: 'v2', block_time: orphans[0].block_time, block_number: '70001', sender: A(77), recipient: A(77), amount0: '5', amount1: '-7' }]);
    await repo.insertLiveTxs([{ tx_hash: orphans[0].tx_hash, block_number: '70001', block_time: orphans[0].block_time, from_addr: A(77), to_addr: A(501) }]);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await wipe();
    await disconnect();
  });

  it('starts from a day that differs in every table', async () => {
    const before = await snapshot();
    for (const table of Object.keys(expected)) expect(before[table]).not.toBe(expected[table]);
  });

  it('records the difference and reads nothing again before it has lasted 30 minutes', async () => {
    await svc.tick();
    expect(await status()).toMatchObject({ status: 'gap' });
    expect(rejects.take().map((r) => r.reason)).toEqual(['day-gap']);
    skew += 20 * MIN;
    await svc.tick();
    expect(slotsAsked).toBe(0);
  });

  it('then fills the hole and corrects the rows, and removes nothing on the provider\'s first "not found"', async () => {
    await x(`UPDATE elysium_day_check SET gap_since = now() - interval '31 minutes' WHERE day = $1::date`, day);
    skew += 11 * MIN;
    for (let runs = 0; runs < 20 && slotsAsked < 144; runs++) await svc.tick();
    expect(await status()).toMatchObject({ status: 'repairing', rows_added: truth.filter(inHole).length, rows_removed: 0 });
    expect(lookups).toBe(3);
    const stillThere = await q<{ n: string }>(`SELECT count(*)::text AS n FROM elysium_tx WHERE tx_hash = ANY($1::text[])`, orphans.map((o) => o.tx_hash));
    expect(stillThere[0].n).toBe('3');
    await svc.tick();
    expect(lookups).toBe(3);
  });

  it('removes them after a second "not found" 10 minutes later, and the day is equal to the provider', async () => {
    skew += 11 * MIN;
    for (let runs = 0; runs < 20 && (await status()).status === 'repairing'; runs++) await svc.tick();
    expect(await status()).toMatchObject({
      status: 'ok',
      repaired: true,
      our_txs: counts.txs,
      our_spam: counts.spam,
      rows_added: truth.filter(inHole).length,
      rows_corrected: 6,
      rows_removed: 3,
    });
    expect(lookups).toBe(6);
    expect(rejects.take()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'reorg', count: 3 })]));
  });

  it('leaves every table as storing the whole day gives it', async () => {
    const after = await snapshot();
    for (const table of Object.keys(expected)) expect(after[table]).toBe(expected[table]);
    const dirty = await q<{ dirty: boolean }>(`SELECT dirty FROM elysium_day_rollup WHERE day = $1::date`, day);
    expect(dirty[0]?.dirty).toBe(true);
  });

  it('reads nothing more once the day is equal', async () => {
    const before = slotsAsked;
    await svc.tick();
    expect(slotsAsked).toBe(before);
  });
});
