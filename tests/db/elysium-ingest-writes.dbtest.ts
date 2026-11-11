/**
 * The statements the ingestion writes with, on a real Postgres: what a real database refuses and
 * how a refused row is set aside, the lists the holder stats and the bridge work from, the
 * launch market state under two writers, the stream cursor, and the rollup builder's lock.
 */
jest.mock('../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../src/core/redis.service', () => ({ redisService: { getClient: () => ({}) } }));

import { prismaHistoricalPages } from '../../src/core/prisma.historical.service';
import { ElysiumIngestRepository } from '../../src/repositories/prisma/prisma.elysium.repository';
import { ElysiumRollupRepository } from '../../src/repositories/prisma/prisma.elysium-rollup.repository';
import { ElysiumIngestionService } from '../../src/services/elysium/elysium-ingestion.service';
import { normalizeBridgeTransfer, normalizeToken, type TokenRow } from '../../src/services/elysium/elysium-ingest.util';
import { DEX_TOPICS, decodePoolCreated } from '../../src/services/elysium/elysium-dex.util';
import type { IngestRejects } from '../../src/services/elysium/elysium-ingest-rejects';
import { A, H, disconnect, q, wipe, x } from './helpers';

const repo = ElysiumIngestRepository.getInstance();
type Writer = {
  rejects: IngestRejects;
  writeRows: <T>(stream: string, rows: T[], write: (rows: T[]) => Promise<number>, describe: (row: T) => string) => Promise<number>;
};

beforeAll(wipe);
afterAll(async () => {
  await wipe();
  await prismaHistoricalPages.$disconnect();
  await disconnect();
});

describe('reject counts', () => {
  it('add up per stream, reason and day; the first sample of the day stays, cleaned of what jsonb refuses', async () => {
    await repo.addRejects([
      { stream: 'tx', reason: 'row-malformed', count: 2, sample: 'first sample' },
      { stream: 'launchpad', reason: 'launch-unknown-emitter', count: 1, sample: 'emitter with a NUL \u0000 and half a pair \ud800 inside' },
    ]);
    await repo.addRejects([{ stream: 'tx', reason: 'row-malformed', count: 5, sample: 'second sample' }]);
    const rows = await q(`SELECT stream, reason, count::text, sample FROM elysium_ingest_reject WHERE day = (now() AT TIME ZONE 'UTC')::date ORDER BY stream`);
    expect(rows).toEqual([
      { stream: 'launchpad', reason: 'launch-unknown-emitter', count: '1', sample: 'emitter with a NUL  and half a pair  inside' },
      { stream: 'tx', reason: 'row-malformed', count: '7', sample: 'first sample' },
    ]);
  });
});

describe('values a real database refuses', () => {
  it('a registry page with a NUL, half a pair, a 300-character symbol and an absurd decimals is stored whole', async () => {
    const raw = [
      { address: A(1), name: 'fine', symbol: 'OK', decimals: 18, transfer_count: 5 },
      { address: A(2), name: 'nul\u0000name', symbol: 'N', decimals: 18, transfer_count: 4 },
      { address: A(3), name: 'half\ud800pair', symbol: 'S'.repeat(300), decimals: 18, transfer_count: 3 },
      { address: A(4), name: 'big decimals', symbol: 'D', decimals: 1e12, transfer_count: 2 },
      { address: A(5), name: 'long standard', standard: 'x'.repeat(40), transfer_count: 1 },
    ];
    await repo.upsertTokens(raw.map((r) => normalizeToken(r)).filter((r): r is TokenRow => r !== null));
    const stored = await q<{ name: string; symbol_len: number; decimals: number | null; standard: string }>(
      `SELECT name, length(symbol) AS symbol_len, decimals, standard FROM elysium_token ORDER BY address`
    );
    expect(stored.map((s) => s.name)).toEqual(['fine', 'nulname', 'halfpair', 'big decimals', 'long standard']);
    expect(stored[2].symbol_len).toBe(128);
    expect(stored[3].decimals).toBeNull();
    expect(stored[4].standard).toHaveLength(16);
  });

  it('three rows Postgres refuses are set aside by halves, and the 197 others are stored', async () => {
    await x(`TRUNCATE elysium_token`);
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    const svc = ElysiumIngestionService.getInstance() as unknown as Writer;
    const page: TokenRow[] = Array.from({ length: 200 }, (_, i) => ({
      address: A(100 + i), standard: 'erc20', name: `t${i}`, symbol: 'T', decimals: 18, origin: null, first_seen: null, transfer_count: '1',
    }));
    page[57].standard = 'x'.repeat(40); // 22001 value too long
    page[143].name = 'nul\u0000'; // 22P05 unsupported Unicode escape
    page[190].decimals = 1e12; // 22003 out of range
    let statements = 0;
    const written = await svc.writeRows('tokens', page, async (part) => {
      statements++;
      return repo.upsertTokens(part);
    }, (r) => r.address);
    expect(written).toBe(197);
    expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM elysium_token`))[0].n).toBe('197');
    expect(svc.rejects.take()).toEqual([expect.objectContaining({ stream: 'tokens', reason: 'row-refused', count: 3 })]);
    expect(statements).toBeLessThanOrEqual(60);
  });

  it('a pool whose fee topic is 2^40 and a transfer with a 33-character status are stored', async () => {
    const word = (hex: string): string => hex.padStart(64, '0');
    const pool = decodePoolCreated({
      block_time: '2026-11-11T10:00:00', block_number: 5, log_index: 0, tx_hash: H(1), address: A(7),
      topic0: DEX_TOPICS.v3PoolCreated, topic1: '0x' + word(A(8).slice(2)), topic2: '0x' + word(A(9).slice(2)), topic3: '0x' + word('10000000000'),
      data: '0x' + word('3c') + word(A(10).slice(2)),
    });
    expect(pool).not.toBeNull();
    await repo.insertDexPools([pool as NonNullable<typeof pool>]);
    expect(await q(`SELECT fee FROM elysium_dex_pool`)).toEqual([{ fee: null }]);
    const transfer = normalizeBridgeTransfer({ transfer_id: 'd:1', initiated_time: '2026-11-11T10:00:00', status: 'a_status_the_provider_added_since', direction: 'deposit' });
    await repo.upsertBridgeTransfers([transfer as NonNullable<typeof transfer>]);
    expect(await q(`SELECT status FROM elysium_bridge_transfer`)).toEqual([{ status: 'a_status_the_provider_ad' }]);
  });
});

describe('the lists the holder stats and the bridge work from', () => {
  beforeAll(async () => {
    await x(`TRUNCATE elysium_launch, elysium_launch_trade, elysium_token, elysium_token_stat, elysium_bridge_transfer`);
    // Launch g was created g minutes ago; the first five were never read.
    await x(`INSERT INTO elysium_launch (token, launchpad, kind, created_at, block_number, tx_hash, quote, stats_at)
             SELECT '0x' || lpad(to_hex(g), 40, '0'), 'Kiln', 'curve', now() - make_interval(mins => g), g, '0x' || lpad(to_hex(g), 64, '0'),
                    '0x0000000000000000000000000000000000000000', CASE WHEN g <= 5 THEN NULL ELSE now() - make_interval(hours => g) END
             FROM generate_series(1, 12) g`);
  });

  it('the launch batch leaves out the tokens set aside and, while the provider lags, the launches created after its head', async () => {
    expect((await repo.listLaunchesForStats(60, 40, 1800, 840)).map((t) => t.token)[0]).toBe(A(1));
    const without = await repo.listLaunchesForStats(60, 40, 1800, 840, [A(1), A(7)]);
    expect(without).toHaveLength(10);
    expect(without.some((t) => t.token === A(1) || t.token === A(7))).toBe(false);
    const upTo = await repo.listLaunchesForStats(60, 40, 1800, 840, [], new Date(Date.now() - 6.5 * 60_000));
    expect(upTo.map((t) => parseInt(t.token.slice(-4), 16)).sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('the top-token list is the never-read ones, then the oldest snapshot first', async () => {
    await x(`INSERT INTO elysium_token (address, standard, symbol, transfer_count, first_seen)
             SELECT '0x' || lpad(to_hex(g), 40, '0'), 'erc20', 'T' || g, 100 - g, now() - interval '3 days' FROM generate_series(1, 6) g`);
    await x(`INSERT INTO elysium_token_stat (address, holders, fetched_at) VALUES ($1, 5, now() - interval '2 hours'), ($2, 5, now() - interval '5 hours'), ($3, 5, now())`, A(1), A(2), A(3));
    expect(await repo.listTokensForStats(25, 840)).toEqual([A(4), A(5), A(6), A(2), A(1)]);
  });

  it('the newest transfer held is read to the millisecond; the deposits still waiting are listed by a hash that can be asked for', async () => {
    expect(await repo.newestBridgeTransferAt()).toBeNull();
    const t = new Date(Date.now() - 3 * 86_400_000);
    await x(`INSERT INTO elysium_bridge_transfer (transfer_id, direction, asset, route, status, l1_tx_hash, initiated_at) VALUES
             ('p:1', 'deposit', 'native', 'native', 'ticket_created', '0x' || repeat('a', 64), $1::timestamptz),
             ('p:2', 'deposit', 'native', 'native', 'ticket_created', '0xnot-a-hash', $1::timestamptz - interval '1 hour'),
             ('p:3', 'deposit', 'native', 'native', 'completed', '0x' || repeat('b', 64), $1::timestamptz + interval '2 hours'),
             ('p:4', 'deposit', 'native', 'native', 'ticket_created', '0x' || repeat('c', 64), now() - interval '2 hours'),
             ('p:5', 'deposit', 'native', 'native', 'ticket_created', '0x' || repeat('d', 64), now() - interval '12 days')`, t.toISOString());
    expect((await repo.newestBridgeTransferAt())?.getTime()).toBeGreaterThan(Date.now() - 3 * 3_600_000);
    expect(await repo.listOpenDeposits(26 * 3600, 10 * 86400, 25, 0)).toEqual([{ transfer_id: 'p:1', tx_hash: '0x' + 'a'.repeat(64) }]);
  });
});

describe('the launch market state', () => {
  const t0 = Date.now() - 3_600_000;
  let seq = 0;
  const trade = (token: number, price: number, amount: number, buy = true) => {
    seq++;
    return { tx_hash: H(100_000 + seq), log_index: 0, token: A(1000 + token), venue: 'curve' as const, block_time: new Date(t0 + seq * 10).toISOString(), block_number: String(1000 + seq), trader: A(5), is_buy: buy, quote_amount: '1', token_amount: String(amount), price };
  };
  const state = () => q<{ token: string; last_price: number | null; last_block: string | null; curve_sold: string | null }>(
    `SELECT token, last_price, last_block::text, curve_sold::text FROM elysium_launch ORDER BY token`);
  const fromTrades = () => q<{ token: string; last_price: number | null; last_block: string | null; curve_sold: string | null }>(
    `SELECT l.token,
            (SELECT tr.price FROM elysium_launch_trade tr WHERE tr.token = l.token AND tr.price > 0 ORDER BY tr.block_number DESC, tr.log_index DESC LIMIT 1) AS last_price,
            (SELECT tr.block_number::text FROM elysium_launch_trade tr WHERE tr.token = l.token AND tr.price > 0 ORDER BY tr.block_number DESC, tr.log_index DESC LIMIT 1) AS last_block,
            (SELECT sum(CASE WHEN tr.is_buy THEN tr.token_amount ELSE -tr.token_amount END)::text FROM elysium_launch_trade tr WHERE tr.token = l.token AND tr.venue = 'curve') AS curve_sold
     FROM elysium_launch l ORDER BY l.token`);
  const N = 20;

  beforeAll(async () => {
    await x(`TRUNCATE elysium_launch, elysium_launch_trade`);
    await repo.insertLaunches(Array.from({ length: N }, (_, i) => ({
      token: A(1000 + i), launchpad: 'CorePad' as const, kind: 'curve' as const, creator: A(1), created_at: new Date(t0).toISOString(),
      block_number: '1', tx_hash: H(i + 1), curve: A(2000 + i), pool: null, quote: A(0), name: `t${i}`, symbol: `T${i}`,
    })));
  });

  it('a trade without a price counts in what the curve sold and never becomes the last price', async () => {
    await repo.insertLaunchTrades([trade(0, 0.5, 100), trade(0, 0.7, 50)]);
    await repo.insertLaunchTrades([trade(0, 0, 30)]);
    await repo.insertLaunchTrades([trade(1, 0, 40)]);
    const rows = await state();
    expect(rows[0]).toMatchObject({ last_price: 0.7, curve_sold: '180' });
    expect(rows[1]).toMatchObject({ last_price: null, curve_sold: '40' });
  });

  it('a rebuild from the trades alone says the same, for a launch whose trades all lack a price too', async () => {
    await x(`UPDATE elysium_launch SET last_price = NULL, last_block = NULL, last_log = NULL, curve_sold = NULL`);
    await repo.rebuildLaunchState(null);
    expect(await state()).toEqual(await fromTrades());
    expect((await state())[1]).toMatchObject({ last_price: null, curve_sold: '40' });
  });

  it('trades inserted by two writers while their launches are rebuilt: nothing is lost, and nobody deadlocks', async () => {
    for (let r = 0; r < 40; r++) {
      await Promise.all([
        repo.rebuildLaunchState(new Date(t0 - 1000)),
        repo.insertLaunchTrades(Array.from({ length: N }, (_, i) => trade(i, 1 + r / 1000, 10 + (r % 7), r % 5 !== 0))),
        repo.insertLaunchTrades(Array.from({ length: N }, (_, i) => trade(i, 2 + r / 1000, 3))),
      ]);
    }
    expect(await state()).toEqual(await fromTrades());
  });
});

describe('the stream cursor and the rollup builder\'s lock', () => {
  it('a writer that is behind leaves the cursor where it is, and its rows are still counted', async () => {
    const t = (s: string): Date => new Date(`2026-11-11T${s}Z`);
    await repo.advance('tx', { cursor: t('10:00:00'), addRows: 5 });
    await repo.advance('tx', { cursor: t('10:05:00'), addRows: 5 });
    await repo.advance('tx', { cursor: t('10:02:00'), addRows: 1 });
    await repo.advance('tx', { addRows: 1 });
    const s = await repo.getState('tx');
    expect(s?.cursor?.toISOString()).toBe('2026-11-11T10:05:00.000Z');
    expect(Number(s?.rows)).toBe(12);
    expect(s?.okAt).not.toBeNull();
  });

  it('a run with nothing to write is recorded as completed, and ends the stream\'s last error', async () => {
    await repo.recordError('tx', 'API error: 500');
    expect((await repo.getState('tx'))?.lastError).toBe('API error: 500');
    await repo.touch('tx');
    const s = await repo.getState('tx');
    expect(s?.lastError).toBeNull();
    expect(s?.cursor?.toISOString()).toBe('2026-11-11T10:05:00.000Z');
  });

  it('a second builder that finds the builders\' lock taken leaves the running build\'s row as it is', async () => {
    const rollups = ElysiumRollupRepository.getInstance();
    const day = '2026-11-01';
    await x(`INSERT INTO elysium_day_rollup (day, built_at, dirty, build_token) VALUES ($1::date, NULL, true, 'the-running-build')`, day);
    const running = prismaHistoricalPages.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('elysium_day_rollup'))::text`);
      await tx.$queryRawUnsafe(`SELECT pg_sleep(3)::text`);
    }, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(await rollups.buildDay(day, { callers: false, senders: false })).toBe('busy');
    expect(await q(`SELECT dirty, build_token FROM elysium_day_rollup WHERE day = $1::date`, day)).toEqual([{ dirty: true, build_token: 'the-running-build' }]);
    await running;
    expect(await rollups.buildDay(day, { callers: false, senders: false })).toBe('built');
  });
});
