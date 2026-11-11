/**
 * The launch market state (last price, curve sold on elysium_launch) is filled
 * once from every trade, healed once a few minutes after each start, and a
 * failure of either never holds the launchpad stream.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/core/redis.service', () => ({ redisService: { getClient: jest.fn(), delete: jest.fn() } }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import { ElysiumIngestionService } from '../../../src/services/elysium/elysium-ingestion.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const MIN = 60_000;

type Internals = { launchStateTick: () => Promise<number>; runTick: (stream: string, tick: () => Promise<number>) => Promise<number>; startedAt: number };

describe('launch market state upkeep', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  let getState: jest.SpyInstance;
  let rebuild: jest.SpyInstance;
  let names: jest.SpyInstance;
  let advance: jest.SpyInstance;

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.startedAt = NOW;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    getState = jest.spyOn(repo, 'getState').mockResolvedValue(null);
    rebuild = jest.spyOn(repo, 'rebuildLaunchState').mockResolvedValue(7);
    names = jest.spyOn(repo, 'fillLaunchNames').mockResolvedValue(3);
    advance = jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
    for (const m of Object.values(mockLog)) m.mockReset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('fills every launch once, then records it', async () => {
    await svc.launchStateTick();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(null);
    expect(names).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith('launchstate', { cursor: expect.any(Date), setRows: 7, backfillDone: true });

    // Later runs of the same process do not look again.
    await svc.launchStateTick();
    expect(getState).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('does not fill again on a later start', async () => {
    getState.mockResolvedValue({ stream: 'launchstate', cursor: new Date(NOW), rows: 7n, backfillDone: true, lastError: null, updatedAt: new Date(NOW), okAt: new Date(NOW) });
    await svc.launchStateTick();
    expect(rebuild).not.toHaveBeenCalled();
    expect(names).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it('heals the recently traded tokens once, five minutes after the start, then has nothing more to do', async () => {
    getState.mockResolvedValue({ stream: 'launchstate', cursor: new Date(NOW), rows: 7n, backfillDone: true, lastError: null, updatedAt: new Date(NOW), okAt: new Date(NOW) });
    (Date.now as jest.Mock).mockReturnValue(NOW + 4 * MIN);
    // Comes back when the five minutes are up.
    expect(await svc.launchStateTick()).toBe(MIN);
    expect(rebuild).not.toHaveBeenCalled();

    (Date.now as jest.Mock).mockReturnValue(NOW + 5 * MIN);
    expect(await svc.launchStateTick()).toBe(6 * 60 * MIN);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(new Date(NOW + 5 * MIN - 120 * MIN));

    (Date.now as jest.Mock).mockReturnValue(NOW + 30 * MIN);
    await svc.launchStateTick();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('a failed rebuild is the loop\'s error (it was only logged, inside the launchpad tick), and the next run does it again', async () => {
    rebuild.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    await expect(svc.launchStateTick()).rejects.toThrow('statement timeout');
    expect(advance).not.toHaveBeenCalled();

    (Date.now as jest.Mock).mockReturnValue(NOW + 10 * MIN);
    await svc.launchStateTick();
    // The fill, then (the start is now over five minutes old) the heal.
    expect(rebuild).toHaveBeenCalledTimes(3);
    expect(rebuild).toHaveBeenNthCalledWith(2, null);
    expect(advance).toHaveBeenCalledWith('launchstate', expect.objectContaining({ backfillDone: true }));
  });

  it('is recorded and tried again like any stream, under a lock and a time limit of its own', async () => {
    const recordError = jest.spyOn(repo, 'recordError').mockResolvedValue(undefined);
    jest.spyOn(repo, 'addRejects').mockResolvedValue(undefined);
    rebuild.mockRejectedValue(new Error('canceling statement due to statement timeout'));
    const next = await svc.runTick('launchstate', () => svc.launchStateTick());
    expect(recordError).toHaveBeenCalledWith('launchstate', 'canceling statement due to statement timeout');
    // Ten minutes, doubled after the first failure.
    expect(next).toBe(20 * MIN);
  });
});
