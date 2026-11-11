/**
 * What the ingestion reads and does not store is counted (2026-11-11): a provider row without
 * the fields a row needs, a launch event from a contract that is not on the list, a trade a
 * launchpad's own contract emitted for a token never seen launching. Each is counted once, when
 * its row is first read, and written to the database as the tick ends.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { getClient: () => ({ set: jest.fn().mockResolvedValue('OK') }), delete: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';
import {
  decodeLaunch,
  decodeLaunchTrade,
  launchRejectReason,
  marketRejectReason,
} from '../../../src/services/elysium/elysium-launchpad.util';
import { ElysiumIngestionService } from '../../../src/services/elysium/elysium-ingestion.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';
import { HypeDexerElysiumIndexerClient } from '../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client';
import fixtures from './fixtures/launchpads-2026-11-02.json';

const fx = fixtures as Record<string, Record<string, unknown>>;

describe('IngestRejects', () => {
  it('adds up per stream and reason, keeps the first sample, and starts over once taken', () => {
    const rejects = new IngestRejects();
    rejects.note('tx', 'row-malformed', 'first');
    rejects.note('tx', 'row-malformed', 'second', 4);
    rejects.note('launchpad', 'launch-unknown-emitter', null);
    rejects.note('launchpad', 'launch-unknown-emitter', 'later sample');

    expect(rejects.take()).toEqual([
      { stream: 'tx', reason: 'row-malformed', count: 5, sample: 'first' },
      { stream: 'launchpad', reason: 'launch-unknown-emitter', count: 2, sample: 'later sample' },
    ]);
    expect(rejects.take()).toEqual([]);
  });

  it('cuts a sample to 400 characters and ignores a count of zero', () => {
    const rejects = new IngestRejects();
    rejects.note('tx', 'row-refused', 'x'.repeat(5000));
    rejects.note('dex', 'log-undecodable', 'never', 0);
    const [only, ...rest] = rejects.take();
    expect(only.sample).toHaveLength(400);
    expect(rest).toEqual([]);
  });

  it('counts a row given with its key once, whatever is noted without a key each time', () => {
    const rejects = new IngestRejects();
    rejects.note('tx', 'row-malformed', 'a', 1, '0xabc');
    rejects.note('tx', 'row-malformed', 'a again', 1, '0xabc');
    rejects.note('tx', 'row-refused', 'same row, another reason', 1, '0xabc');
    rejects.note('dex', 'row-malformed', 'same key, another stream', 1, '0xabc');
    rejects.note('launchstats', 'token-unreadable', 't');
    rejects.note('launchstats', 'token-unreadable', 't');
    expect(rejects.take().map((r) => [r.stream, r.reason, r.count])).toEqual([
      ['tx', 'row-malformed', 1],
      ['tx', 'row-refused', 1],
      ['dex', 'row-malformed', 1],
      ['launchstats', 'token-unreadable', 2],
    ]);
    // Still remembered after the counts were taken.
    rejects.note('tx', 'row-malformed', 'a third time', 1, '0xabc');
    expect(rejects.take()).toEqual([]);
  });

  it('puts back what could not be written, on top of what was counted since', () => {
    const rejects = new IngestRejects();
    rejects.note('tx', 'row-malformed', 'a', 2);
    const taken = rejects.take();
    rejects.note('tx', 'row-malformed', 'b');
    rejects.restore(taken);
    expect(rejects.take()).toEqual([{ stream: 'tx', reason: 'row-malformed', count: 3, sample: 'b' }]);
  });
});

describe('why a launchpad log was not stored', () => {
  const kilnLaunch = fx['0xcfc6745d:1'];
  const bunnyTrade = fx['0x98ab5d27:3'];

  it('says nothing of a launch that decodes', () => {
    expect(decodeLaunch(kilnLaunch)).not.toBeNull();
  });

  it('names the emitter of a launch event that does not come from the launchpad’s contract', () => {
    const stranger = { ...kilnLaunch, address: '0x1111111111111111111111111111111111111111' };
    expect(decodeLaunch(stranger)).toBeNull();
    const reject = launchRejectReason(stranger);
    expect(reject?.reason).toBe('launch-unknown-emitter');
    expect(reject?.sample).toContain('0x1111111111111111111111111111111111111111');
    expect(reject?.sample).toContain(String(kilnLaunch.tx_hash).toLowerCase());
  });

  it('tells a launch event of the right contract that does not decode from an unknown emitter', () => {
    const broken = { ...kilnLaunch, topic1: '' };
    expect(decodeLaunch(broken)).toBeNull();
    expect(launchRejectReason(broken)?.reason).toBe('log-undecodable');
  });

  it('calls a log without its fields malformed', () => {
    expect(launchRejectReason({ topic0: kilnLaunch.topic0 })?.reason).toBe('log-malformed');
    expect(marketRejectReason(null, () => true)?.reason).toBe('log-malformed');
  });

  it('counts a trade the pad itself emitted for a token that never launched here', () => {
    expect(decodeLaunchTrade(bunnyTrade, new Map())).toBeNull();
    const reject = marketRejectReason(bunnyTrade, () => false);
    expect(reject?.reason).toBe('market-unknown');
    expect(reject?.sample).toContain('market 0x');
  });

  it('does not count a trade whose market is known (a zero amount is not a reject)', () => {
    expect(marketRejectReason(bunnyTrade, () => true)).toBeNull();
  });

  it('does not count a Swap of a pool that is not a launch market, nor a curve nobody listed', () => {
    expect(marketRejectReason(fx['0xa486938c:5'], () => false)).toBeNull(); // Uniswap V3 Swap
    expect(marketRejectReason(fx['0xe1e71d84:1'], () => false)).toBeNull(); // Kiln CurveBuy, emitted by a curve
  });

  it('counts a graduation the Kiln factory emitted for a token that never launched here', () => {
    expect(marketRejectReason(fx['0xa2fff043:10'], () => false)?.reason).toBe('market-unknown');
    expect(marketRejectReason(fx['0xa2fff043:10'], () => true)).toBeNull();
  });
});

describe('Elysium ingestion: left-out rows are counted and written', () => {
  const NOW = Date.parse('2026-11-11T12:00:00.000Z');
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
  type Internals = {
    stopped: boolean;
    throttle: { wait: () => Promise<void> };
    rejects: IngestRejects;
    txTick: () => Promise<number>;
    runTick: (stream: string, tick: () => Promise<number>) => Promise<number>;
  };
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  let addRejects: jest.SpyInstance;
  let fetchPage: jest.SpyInstance;

  const page = (rows: unknown[]) => ({ rows, hasMore: false });
  const tx = (n: number, at: number, over: Record<string, unknown> = {}) => ({
    tx_hash: `0x${n.toString(16).padStart(64, '0')}`,
    from_addr: `0x${'a'.repeat(40)}`,
    block_number: 100 + n,
    block_time: iso(at),
    gas_used: 21000,
    effective_gas_price: 1,
    success: true,
    ...over,
  });

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(client, 'fetchIngestHead').mockResolvedValue(new Date(NOW - 5_000));
    fetchPage = jest.spyOn(client, 'fetchIngestPage');
    jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
    jest.spyOn(repo, 'recordError').mockResolvedValue(undefined);
    jest.spyOn(repo, 'insertTxs').mockImplementation(async (rows) => ({ inserted: rows.length, contracts: 0 }));
    jest.spyOn(repo, 'getState').mockResolvedValue({
      stream: 'tx',
      cursor: new Date(NOW - 45_000),
      rows: 0n,
      backfillDone: true,
      lastError: null,
      updatedAt: new Date(NOW),
    });
    addRejects = jest.spyOn(repo, 'addRejects').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('counts a transaction without a sender, not the system ones', async () => {
    fetchPage.mockResolvedValue(page([
      tx(1, NOW - 30_000),
      tx(2, NOW - 30_000, { from_addr: '' }), // malformed
      tx(3, NOW - 30_000, { is_system: true, from_addr: '' }), // left out on purpose
    ]));

    await svc.runTick('tx', () => svc.txTick());

    expect(repo.insertTxs).toHaveBeenCalledWith([expect.objectContaining({ tx_hash: tx(1, 0).tx_hash })]);
    expect(addRejects).toHaveBeenCalledTimes(1);
    expect(addRejects.mock.calls[0][0]).toEqual([
      expect.objectContaining({ stream: 'tx', reason: 'row-malformed', count: 1, sample: expect.stringContaining(tx(2, 0).tx_hash) }),
    ]);
  });

  it('counts a row once however often it is read again (the overlap of the next window, a tick run again)', async () => {
    fetchPage.mockResolvedValue(page([tx(2, NOW - 30_000, { from_addr: '' })]));
    await svc.runTick('tx', () => svc.txTick());
    await svc.runTick('tx', () => svc.txTick());
    await svc.runTick('tx', () => svc.txTick());
    expect(addRejects).toHaveBeenCalledTimes(1);

    // Another row left out is counted in its turn.
    fetchPage.mockResolvedValue(page([tx(2, NOW - 30_000, { from_addr: '' }), tx(7, NOW - 20_000, { from_addr: '' })]));
    await svc.runTick('tx', () => svc.txTick());
    expect(addRejects).toHaveBeenCalledTimes(2);
    expect(addRejects.mock.calls[1][0]).toEqual([expect.objectContaining({ count: 1, sample: expect.stringContaining(tx(7, 0).tx_hash) })]);
  });

  it('writes nothing when nothing was left out', async () => {
    fetchPage.mockResolvedValue(page([tx(1, NOW - 30_000)]));
    await svc.runTick('tx', () => svc.txTick());
    expect(addRejects).not.toHaveBeenCalled();
  });

  it('keeps the counts when they cannot be written, and writes them with the next tick’s', async () => {
    fetchPage.mockResolvedValue(page([tx(2, NOW - 30_000, { from_addr: '' })]));
    addRejects.mockRejectedValueOnce(new Error('connection lost'));
    await svc.runTick('tx', () => svc.txTick());
    expect(svc.rejects.size).toBe(1);

    fetchPage.mockResolvedValue(page([tx(5, NOW - 20_000, { tx_hash: '' })]));
    await svc.runTick('tx', () => svc.txTick());
    expect(addRejects).toHaveBeenLastCalledWith([expect.objectContaining({ stream: 'tx', reason: 'row-malformed', count: 2 })]);
    expect(svc.rejects.size).toBe(0);
  });

  it('writes the counts of a tick that failed, too', async () => {
    fetchPage.mockResolvedValueOnce(page([tx(1, NOW - 30_000), tx(2, NOW - 30_000, { from_addr: '' })]));
    (repo.insertTxs as jest.Mock).mockRejectedValueOnce(new Error('connection lost'));
    await svc.runTick('tx', () => svc.txTick());
    expect(repo.recordError).toHaveBeenCalled();
    expect(addRejects).toHaveBeenCalledWith([expect.objectContaining({ reason: 'row-malformed', count: 1 })]);
  });
});
