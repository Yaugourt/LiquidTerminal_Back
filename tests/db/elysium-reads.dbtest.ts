/**
 * What the Elysium views read, on a real Postgres: the fees total over a window read partly from
 * the day rollups, the ecosystem count while the RPC fallback and the provider's stream overlap,
 * and the status of the streams.
 */
jest.mock('../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));
// No Redis here: what reads it (the credit totals) answers "unknown", as it does when Redis is down.
jest.mock('../../src/core/redis.service', () => ({ redisService: { getClient: () => ({}) } }));

import { prismaHistoricalAggregate, prismaHistoricalPages, prismaHistoricalRead } from '../../src/core/prisma.historical.service';
import { ELYSIUM_PROJECTS } from '../../src/constants/elysium-projects';
import { ElysiumIngestRepository } from '../../src/repositories/prisma/prisma.elysium.repository';
import { ElysiumRollupRepository } from '../../src/repositories/prisma/prisma.elysium-rollup.repository';
import { ElysiumAnalyticsService } from '../../src/services/elysium/elysium-analytics.service';
import { ElysiumEcosystemService } from '../../src/services/elysium/elysium-ecosystem.service';
import { A, H, disconnect, q, wipe, x, type TxFixture } from './helpers';

const repo = ElysiumIngestRepository.getInstance();
const DAY_MS = 86_400_000;

interface FeesValue {
  from: string;
  to: string;
  totals: Record<string, number>;
}
interface StatusValue {
  streams: Array<Record<string, unknown>>;
  provider: Record<string, unknown>;
  upkeep: Array<Record<string, unknown>>;
  credits: unknown;
  database: { bytes: number; volumeBytes: number | null; usedShare: number | null };
}
const analytics = ElysiumAnalyticsService.getInstance() as unknown as {
  feesView: (window: string) => { compute: () => Promise<FeesValue> };
  statusView: () => { compute: () => Promise<StatusValue> };
};

afterAll(async () => {
  await wipe();
  await Promise.all([prismaHistoricalAggregate.$disconnect(), prismaHistoricalPages.$disconnect(), prismaHistoricalRead.$disconnect()]);
  await disconnect();
});

describe('the fees over a window read partly from the day rollups', () => {
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const utcDay = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  const closedDays = [3, 2, 1].map(utcDay);
  const raw = async (v: FeesValue): Promise<{ fee: number; n: number; called: number; creations: number; spam: number }> =>
    (
      await q<{ fee: number; n: number; called: number; creations: number; spam: number }>(
        `SELECT (COALESCE(sum(fee_wei), 0) / 1e18)::float8 AS fee, count(*)::int AS n,
                (COALESCE(sum(fee_wei) FILTER (WHERE NOT is_spam AND to_addr IS NOT NULL), 0) / 1e18)::float8 AS called,
                (COALESCE(sum(fee_wei) FILTER (WHERE NOT is_spam AND to_addr IS NULL), 0) / 1e18)::float8 AS creations,
                (COALESCE(sum(fee_wei) FILTER (WHERE is_spam), 0) / 1e18)::float8 AS spam
         FROM elysium_tx WHERE block_time >= $1::timestamptz AND block_time < $2::timestamptz`,
        v.from,
        v.to
      )
    )[0];

  beforeAll(async () => {
    await wipe();
    let n = 0;
    const row = (at: number, kind: 'call' | 'transfer' | 'creation' | 'spam'): TxFixture => {
      n++;
      return {
        tx_hash: H(n),
        block_number: String(n),
        block_time: new Date(at).toISOString(),
        from_addr: A(5000 + (n % 7)),
        to_addr: kind === 'creation' ? null : kind === 'call' ? A(900) : A(7000 + n),
        contract_address: kind === 'creation' ? A(8000 + n) : null,
        method_id: kind === 'call' ? '0xa9059cbb' : null,
        tx_type: '0x2',
        gas_used: '21000',
        fee_wei: String(BigInt(n) * 1_000_000_000_000_000n),
        success: true,
        is_spam: kind === 'spam',
      };
    };
    const rows: TxFixture[] = [];
    for (const daysAgo of [3, 2, 1]) {
      const noon = Date.parse(`${utcDay(daysAgo)}T12:00:00Z`);
      for (let i = 0; i < 4; i++) rows.push(row(noon + i * 1000, 'call'));
      for (let i = 0; i < 2; i++) rows.push(row(noon + 60_000 + i * 1000, 'transfer'));
      rows.push(row(noon + 120_000, 'creation'), row(noon + 180_000, 'spam'));
    }
    // Today: not in a rollup, read from the raw table.
    const recent = Date.now() - 90_000;
    rows.push(row(recent, 'call'), row(recent + 1000, 'call'), row(recent + 2000, 'creation'), row(recent + 3000, 'spam'));
    await repo.insertTxs(rows);
    for (const day of closedDays) {
      expect(await ElysiumRollupRepository.getInstance().buildDay(day, { callers: true, senders: true })).toBe('built');
    }
  });

  it('the total is every fee paid over the window, and its four parts add up to it', async () => {
    const v = await analytics.feesView('7d').compute();
    const all = await raw(v);
    const t = v.totals;
    expect(all.n).toBe(28);
    expect(t.txs).toBe(all.n);
    expect(close(t.feesHype, all.fee)).toBe(true);
    expect(close(t.appFeesHype + t.systemFeesHype + t.transferFeesHype, all.called)).toBe(true);
    expect(all.creations).toBeGreaterThan(0);
    expect(close(t.otherFeesHype, all.creations + all.spam)).toBe(true);
    expect(Math.abs(t.appShare + t.systemShare + t.transferShare + t.otherShare - 1)).toBeLessThan(1e-9);
  });

  it('the same window read from the raw table alone says the same, and the built days are really read from the rollups', async () => {
    const fromRollups = (await analytics.feesView('7d').compute()).totals;
    await x(`UPDATE elysium_day_rollup SET dirty = true`);
    const fromRaw = (await analytics.feesView('7d').compute()).totals;
    for (const key of ['feesHype', 'appFeesHype', 'systemFeesHype', 'transferFeesHype', 'otherFeesHype']) {
      expect(close(fromRaw[key], fromRollups[key])).toBe(true);
    }
    expect(fromRaw.txs).toBe(fromRollups.txs);
    // One HYPE added to a built day's total shows in the view: that day comes from its rollup.
    await x(`UPDATE elysium_day_rollup SET dirty = false`);
    await x(`UPDATE elysium_day_rollup SET fee_wei = fee_wei + 1000000000000000000 WHERE day = $1::date`, closedDays[2]);
    const shifted = (await analytics.feesView('7d').compute()).totals;
    expect(close(shifted.feesHype, fromRollups.feesHype + 1)).toBe(true);
  });
});

describe('the ecosystem count while the RPC fallback and the provider\'s stream overlap', () => {
  it('a call the stream stored after its cursor was read is counted once', async () => {
    await wipe();
    const project = ELYSIUM_PROJECTS.find((p) => p.contracts.length > 0);
    if (!project) throw new Error('no project with a contract');
    const target = project.contracts[0].address.toLowerCase();
    const now = Date.now();
    const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
    const txRow = (n: number, msAgo: number): TxFixture => ({
      tx_hash: H(n), block_number: String(n), block_time: at(msAgo), from_addr: A(n), to_addr: target, contract_address: null,
      method_id: '0xa9059cbb', tx_type: '0x2', gas_used: '21000', fee_wei: '21000', success: true, is_spam: false,
    });
    const live = (n: number, msAgo: number) => ({ tx_hash: H(n), block_number: String(n), block_time: at(msAgo), from_addr: A(n), to_addr: target });
    // The provider's stream stood at 10 minutes ago when the view read its cursor...
    await repo.advance('tx', { cursor: new Date(now - 600_000), addRows: 0, backfillDone: true });
    await repo.insertTxs([txRow(1, 3_600_000), txRow(2, 900_000)]);
    // ...the RPC fallback had read three calls after that...
    await repo.insertLiveTxs([live(3, 300_000), live(4, 240_000), live(5, 120_000)]);
    // ...and the stream has since stored two of them, its cursor row not yet moved.
    await repo.insertTxs([txRow(3, 300_000), txRow(4, 240_000)]);
    const eco = ElysiumEcosystemService.getInstance() as unknown as { computeAllTime: () => Promise<Array<{ slug: string; txs: number; wallets: number }>> };
    const mine = (await eco.computeAllTime()).find((r) => r.slug === project.slug);
    expect(mine).toMatchObject({ txs: 5, wallets: 5 });
  });
});

describe('the status of the streams', () => {
  let status: StatusValue;
  let by: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    await wipe();
    const now = Date.now();
    const at = (sAgo: number): Date => new Date(now - sAgo * 1000);
    // The provider stopped six hours ago. tx waits at its head; dex reads from the RPC; tokens ran 10 minutes ago.
    await repo.recordProviderHead(at(6 * 3600));
    await repo.advance('tx', { cursor: at(6 * 3600 + 3), addRows: 10, backfillDone: true });
    await repo.advance('dex', { cursor: at(40), addRows: 5, backfillDone: true });
    await repo.advance('tokens', { cursor: at(600), setRows: 40000, backfillDone: true });
    await repo.advance('launchstate', { cursor: at(900), setRows: 7, backfillDone: true });
    // bridge failed its last run; launchpad has not completed a run for an hour.
    await repo.advance('bridge', { cursor: at(6 * 3600), addRows: 1, backfillDone: true });
    await repo.recordError('bridge', 'API error: 503 Service Unavailable');
    await repo.advance('launchpad', { cursor: at(3600), addRows: 1, backfillDone: true });
    await x(`UPDATE elysium_ingest_state SET ok_at = now() - interval '1 hour' WHERE stream = 'launchpad'`);
    // A run with nothing to write: recorded as completed, and its old error is over.
    await repo.recordError('tx', 'API error: 500');
    await repo.touch('tx');
    status = await analytics.statusView().compute();
    by = Object.fromEntries(status.streams.map((s) => [String(s.stream), s]));
  });

  it('a stream at the provider\'s head waits for the provider: the hours of lag are not its own', () => {
    expect(by.tx).toMatchObject({ state: 'waiting-provider', lastError: null });
    expect(Number(by.tx.lagSeconds)).toBeGreaterThanOrEqual(21_600);
    expect(typeof by.tx.lastOkAt).toBe('string');
    expect(Number(status.provider.lagSeconds)).toBeGreaterThanOrEqual(21_600);
    expect(typeof status.provider.headAt).toBe('string');
  });

  it('a stream is ok, failing with its error, or stalled when no run completed for too long', () => {
    expect(by.dex.state).toBe('ok');
    expect(Number(by.dex.lagSeconds)).toBeLessThan(120);
    expect(by.tokens).toMatchObject({ state: 'ok', lagSeconds: null, everyS: 900 });
    expect(by.bridge).toMatchObject({ state: 'failing', lastError: 'upstream_http_503' });
    expect(by.launchpad.state).toBe('stalled');
  });

  it('the markers are not streams: the one-time jobs are listed apart', () => {
    expect('provider' in by).toBe(false);
    expect('launchstate' in by).toBe(false);
    expect(status.upkeep.map((u) => [u.name, u.done, u.lastError])).toEqual([['launchstate', true, null]]);
  });

  it('the size of the database is shown, with the share in use once the volume\'s size is given', async () => {
    expect(status.database.bytes).toBeGreaterThan(1_000_000);
    expect(status.database).toMatchObject({ volumeBytes: null, usedShare: null });
    expect(status.credits).toBeNull();
    process.env.HISTORICAL_DB_VOLUME_BYTES = String(status.database.bytes * 2);
    try {
      const withVolume = await analytics.statusView().compute();
      expect(Math.abs(Number(withVolume.database.usedShare) - 0.5)).toBeLessThan(0.05);
    } finally {
      delete process.env.HISTORICAL_DB_VOLUME_BYTES;
    }
  });
});
