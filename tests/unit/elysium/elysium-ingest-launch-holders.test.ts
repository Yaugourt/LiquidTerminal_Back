/**
 * A launch's holder list was read up to 1,000 rows, billed by the row, to keep three figures:
 * how many holders, what the ten largest hold, what the creator holds. The launches traded over
 * a day, read every half hour, cost 11,500 credits a round that way (661 launches, 17 of them
 * past 1,000 holders, 2026-11-12). The list is now the 20 largest; a full one takes its count
 * from the token's page, and a creator who is not in it has their share read from the chain.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { getClient: () => ({ set: jest.fn().mockResolvedValue('OK') }), delete: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import { ElysiumIngestionService } from '../../../src/services/elysium/elysium-ingestion.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';
import { HypeDexerElysiumIndexerClient } from '../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client';
import { ElysiumRpcLogs } from '../../../src/services/elysium/elysium-rpc-logs';
import { CHAINZY_CREATOR_LOCKER, V4_POOL_MANAGERS } from '../../../src/services/elysium/elysium-launchpad.util';
import type { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const TOKEN = ADDR(0xaaa);
const CREATOR = ADDR(0xc0ffee);
const CURVE = ADDR(0xc);
const POOL = ADDR(0xd);

type Internals = {
  stopped: boolean;
  throttle: { wait: () => Promise<void> };
  rejects: IngestRejects;
  launchStatsTick: () => Promise<number>;
};

describe('Elysium ingestion: a launch\'s holders, read as the 20 largest', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  const rpc = ElysiumRpcLogs.getInstance();
  let holders: jest.SpyInstance;
  let detail: jest.SpyInstance;
  let chain: jest.SpyInstance;
  let update: jest.SpyInstance;
  /** The provider's whole list for the token, largest first; a call gets its first `limit` rows. */
  let all: Array<{ address: string; share: number }>;
  /** `n` holders of 1% each, after the ones given. */
  const list = (n: number, first: Array<{ address: string; share: number }> = []): Array<{ address: string; share: number }> => [
    ...first,
    ...Array.from({ length: n - first.length }, (_, i) => ({ address: ADDR(1000 + i), share: 0.01 })),
  ];
  const launch = (over: Record<string, unknown> = {}) => ({ token: TOKEN, creator: CREATOR, curve: CURVE, pool: POOL, needsName: false, ...over });
  const written = (): { count: number; top10: number; dev: number | null } => {
    const [, count, top10, dev] = update.mock.calls[0] as [string, number, number, number | null];
    return { count, top10, dev };
  };

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    all = [];
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(client, 'fetchIngestHead').mockResolvedValue(new Date(NOW - 5_000));
    holders = jest.spyOn(client, 'fetchIngestTokenHolders').mockImplementation(async (_token, limit) => all.slice(0, limit));
    detail = jest.spyOn(client, 'fetchIngestToken').mockImplementation(async () => ({ address: TOKEN, holders: all.length, transfer_count: 900 }));
    chain = jest.spyOn(rpc, 'holderShare').mockResolvedValue(0.0007776557661476292);
    update = jest.spyOn(repo, 'updateLaunchStats').mockResolvedValue(undefined);
    jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
    jest.spyOn(repo, 'listLaunchesForStats').mockResolvedValue([launch()] as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks the provider for 20 holders, not 1,000', async () => {
    all = list(5);
    await svc.launchStatsTick();
    expect(holders).toHaveBeenCalledTimes(1);
    expect(holders).toHaveBeenCalledWith(TOKEN, 20);
  });

  it('a list that is whole says everything: no token page, no call to the chain; a creator who is not in it holds nothing', async () => {
    all = list(19, [{ address: ADDR(1), share: 0.5 }]);
    await svc.launchStatsTick();

    expect(detail).not.toHaveBeenCalled();
    expect(chain).not.toHaveBeenCalled();
    expect(written().count).toBe(19);
    expect(written().dev).toBe(0);
    // The ten largest: 50% and nine of 1%.
    expect(written().top10).toBeCloseTo(59, 9);
  });

  it('a full list takes the count from the token\'s page, and the creator\'s share from the list when they are in it', async () => {
    all = list(127, [{ address: ADDR(1), share: 0.3 }, { address: CREATOR, share: 0.05 }]);
    await svc.launchStatsTick();

    expect(detail).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
    expect(holders).toHaveBeenCalledTimes(1);
    expect(written().count).toBe(127);
    expect(written().dev).toBeCloseTo(5, 9);
    expect(written().top10).toBeCloseTo(30 + 5 + 8, 9);
  });

  it('a creator who is not among the 20 largest: their share is read from the chain, not taken for nothing', async () => {
    // The real case of 2026-11-12: 127 holders, the creator the last of them with 0.078% of the supply.
    all = [...list(126), { address: CREATOR, share: 0.0007776557661476292 }];
    await svc.launchStatsTick();

    expect(chain).toHaveBeenCalledWith(TOKEN, CREATOR);
    // One list of 20 and the token's page: 4 + 3 credits where the whole list was 15.
    expect(holders).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({ count: 127, top10: expect.closeTo(10, 9), dev: expect.closeTo(0.07776557661476292, 12) });
  });

  it('a token with no supply on the chain: the creator holds nothing of it', async () => {
    all = list(40);
    chain.mockResolvedValue(null);
    await svc.launchStatsTick();
    expect(written().dev).toBe(0);
  });

  it('when the chain cannot be asked, the provider\'s list is read as far as before: the share is never guessed', async () => {
    all = [...list(126), { address: CREATOR, share: 0.0007776557661476292 }];
    chain.mockRejectedValue(new Error('Elysium RPC: HTTP 429'));
    await svc.launchStatsTick();

    expect(holders.mock.calls.map((c) => c[1])).toEqual([20, 1000]);
    expect(written().dev).toBeCloseTo(0.07776557661476292, 12);
    expect(svc.rejects.take()).toEqual([]);
  });

  it('...and when that read fails too, the token is set aside like any that cannot be read: nothing is written for it', async () => {
    all = list(40);
    chain.mockRejectedValue(new Error('Elysium RPC: HTTP 429'));
    holders.mockImplementation(async (_token, limit) => {
      if (limit > 20) throw new Error('API error: 500 Internal Server Error');
      return all.slice(0, limit);
    });
    await svc.launchStatsTick();

    expect(update).not.toHaveBeenCalled();
    expect(svc.rejects.take()).toEqual([expect.objectContaining({ stream: 'launchstats', reason: 'token-unreadable', count: 1 })]);
  });

  it('a full list whose token page gives no count is not stored as 20 holders: the token is read again later', async () => {
    all = list(127);
    for (const page of [null, { address: TOKEN }, { address: TOKEN, holders: 'many' }]) {
      update.mockClear();
      (svc as unknown as { asideUntil: Map<string, number> }).asideUntil.clear();
      detail.mockResolvedValue(page);
      await svc.launchStatsTick();
      expect(update).not.toHaveBeenCalled();
    }
    expect(svc.rejects.take()).toEqual([expect.objectContaining({ stream: 'launchstats', reason: 'token-unreadable', count: 3 })]);
  });

  it('a page that counts fewer holders than the list shows (read a moment apart) never lowers the count under the list', async () => {
    all = list(127);
    detail.mockResolvedValue({ address: TOKEN, holders: 19 });
    await svc.launchStatsTick();
    expect(written().count).toBe(20);
  });

  describe('the token page goes with the list, not after it in a turn of its own', () => {
    let turns: number;
    beforeEach(() => {
      turns = 0;
      svc.throttle = { wait: async () => void turns++ };
      // The provider's head is known: the only turns taken are the launch's own.
      (svc as unknown as { head: { at: number; value: Date } }).head = { at: NOW, value: new Date(NOW - 5_000) };
    });

    it('a launch whose last read counted 20 holders or more: both are asked at once, in one turn', async () => {
      all = list(127, [{ address: CREATOR, share: 0.05 }]);
      jest.spyOn(repo, 'listLaunchesForStats').mockResolvedValue([launch({ lastHolders: 126 })] as never);
      const order: string[] = [];
      let answerList: () => void = () => undefined;
      holders.mockImplementation(async (_token, limit) => {
        order.push('list asked');
        await new Promise<void>((resolve) => (answerList = resolve));
        order.push('list answered');
        return all.slice(0, limit);
      });
      detail.mockImplementation(async () => {
        order.push('page asked');
        return { address: TOKEN, holders: 127 };
      });

      const run = svc.launchStatsTick();
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(['page asked', 'list asked']);
      answerList();
      await run;

      expect(detail).toHaveBeenCalledTimes(1);
      expect(turns).toBe(1);
      expect(written().count).toBe(127);
    });

    it('...and when its list is no longer full, the page counts for nothing, even one that failed', async () => {
      all = list(12);
      jest.spyOn(repo, 'listLaunchesForStats').mockResolvedValue([launch({ lastHolders: 40 })] as never);
      detail.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
      await svc.launchStatsTick();

      expect(written().count).toBe(12);
      expect(svc.rejects.take()).toEqual([]);
    });

    it('a launch that had fewer, or was never read: the page is asked only once the list comes back full, still in the same turn', async () => {
      for (const lastHolders of [null, 19]) {
        update.mockClear();
        detail.mockClear();
        turns = 0;
        all = list(60);
        jest.spyOn(repo, 'listLaunchesForStats').mockResolvedValue([launch({ creator: null, lastHolders })] as never);
        await svc.launchStatsTick();
        expect(detail).toHaveBeenCalledTimes(1);
        expect(turns).toBe(1);
        expect(written().count).toBe(60);
      }
      // ...and not at all for a list that is whole.
      detail.mockClear();
      all = list(5);
      await svc.launchStatsTick();
      expect(detail).not.toHaveBeenCalled();
    });

    it('a list that fails while the page is on its way sets the token aside like any other, without a stray rejection', async () => {
      jest.spyOn(repo, 'listLaunchesForStats').mockResolvedValue([launch({ lastHolders: 500 })] as never);
      holders.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
      detail.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
      await svc.launchStatsTick();
      expect(update).not.toHaveBeenCalled();
      expect(svc.rejects.take()).toEqual([expect.objectContaining({ reason: 'token-unreadable', count: 1 })]);
    });
  });

  it('a launch without a known creator asks nothing of the chain', async () => {
    all = list(40);
    jest.spyOn(repo, 'listLaunchesForStats').mockResolvedValue([launch({ creator: null })] as never);
    await svc.launchStatsTick();
    expect(chain).not.toHaveBeenCalled();
    expect(written().dev).toBeNull();
  });

  it('the ten largest outside the token\'s own market are always within the 20 read', async () => {
    // Every address left out of the ten (curve, pool, creator locker, both V4 managers) ahead of the holders.
    const parked = [CURVE, POOL, CHAINZY_CREATOR_LOCKER, ...V4_POOL_MANAGERS].map((address) => ({ address, share: 0.1 }));
    expect(parked.length).toBeLessThanOrEqual(10);
    all = list(60, [...parked, ...Array.from({ length: 10 }, (_, i) => ({ address: ADDR(50 + i), share: 0.02 }))]);
    await svc.launchStatsTick();

    expect(holders).toHaveBeenCalledWith(TOKEN, 20);
    // Ten holders of 2%, none of the parked supply.
    expect(written().top10).toBeCloseTo(20, 9);
  });

  it('a token the provider does not know is still counted and left alone, as before', async () => {
    holders.mockResolvedValue(null);
    await svc.launchStatsTick();
    expect(update).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    expect(svc.rejects.take()).toEqual([expect.objectContaining({ reason: 'token-unreadable' })]);
  });
});
