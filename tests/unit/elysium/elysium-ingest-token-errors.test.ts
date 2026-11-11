/**
 * A token whose holder figures the provider would not give used to end the run where it stood,
 * and the same token came first on the next run: the tokens behind it were never read
 * (2026-11-11). Now a token the provider does not know (its 404) is counted and left alone for
 * 30 minutes, without ever counting as a failure; a read that fails is counted, left alone for
 * 5 minutes, and three of them in a row fail the run (the provider is failing), after every one
 * of them was set aside. While the provider lags, the launches it cannot know yet are not asked.
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
import type { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const TOKEN = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

type Internals = {
  stopped: boolean;
  throttle: { wait: () => Promise<void> };
  rejects: IngestRejects;
  launchStatsTick: () => Promise<number>;
  tokenStatsTick: () => Promise<number>;
};

describe('Elysium ingestion: a token that cannot be read', () => {
  let svc: Internals;
  const repo = ElysiumIngestRepository.getInstance();
  const client = HypeDexerElysiumIndexerClient.getInstance();
  let clock: number;
  let holders: jest.SpyInstance;
  let list: jest.SpyInstance;
  let update: jest.SpyInstance;
  let advance: jest.SpyInstance;
  const targets = (...ns: number[]) => ns.map((n) => ({ token: TOKEN(n), creator: null, curve: null, pool: null }));
  /** The provider fails on these tokens (a 5xx), and answers the others. */
  const refusing = (...ns: number[]): void => {
    const bad = new Set(ns.map(TOKEN));
    holders.mockImplementation(async (token: string) => {
      if (bad.has(token)) throw new Error('API error: 500 Internal Server Error');
      return [{ address: TOKEN(900), share: 0.25 }];
    });
  };
  /** The provider does not know these tokens (its 404, which the client returns as null). */
  const unknown = (...ns: number[]): void => {
    const bad = new Set(ns.map(TOKEN));
    holders.mockImplementation(async (token: string) => (bad.has(token) ? null : [{ address: TOKEN(900), share: 0.25 }]));
  };

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.spyOn(client, 'fetchIngestHead').mockImplementation(async () => new Date(clock - 5_000));
    holders = jest.spyOn(client, 'fetchIngestTokenHolders');
    list = jest.spyOn(repo, 'listLaunchesForStats');
    update = jest.spyOn(repo, 'updateLaunchStats').mockResolvedValue(undefined);
    advance = jest.spyOn(repo, 'advance').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads the tokens behind the one that fails, and counts it', async () => {
    list.mockResolvedValue(targets(1, 2, 3, 4));
    refusing(2);

    const next = await svc.launchStatsTick();

    expect(update.mock.calls.map((c) => c[0])).toEqual([TOKEN(1), TOKEN(3), TOKEN(4)]);
    expect(advance).toHaveBeenCalledWith('launchstats', expect.objectContaining({ addRows: 3 }));
    expect(next).toBe(5 * 60_000);
    expect(svc.rejects.take()).toEqual([
      { stream: 'launchstats', reason: 'token-unreadable', count: 1, sample: `${TOKEN(2)} API error: 500 Internal Server Error` },
    ]);
  });

  it('a token the provider does not know is an answer, not a failure: any number of them in a row, and the run goes on', async () => {
    list.mockResolvedValue(targets(1, 2, 3, 4, 5, 6, 7, 8));
    unknown(1, 2, 3, 4, 5, 6);

    await expect(svc.launchStatsTick()).resolves.toBe(5 * 60_000);

    expect(update.mock.calls.map((c) => c[0])).toEqual([TOKEN(7), TOKEN(8)]);
    expect(svc.rejects.take()).toEqual([
      { stream: 'launchstats', reason: 'token-unreadable', count: 6, sample: `${TOKEN(1)} unknown to the provider` },
    ]);
    // Left out for 30 minutes, not stored as "0 holders".
    list.mockResolvedValue([]);
    clock = NOW + 29 * 60_000;
    await svc.launchStatsTick();
    expect((list.mock.calls[list.mock.calls.length - 1][4] as string[]).sort()).toEqual([1, 2, 3, 4, 5, 6].map(TOKEN));
    clock = NOW + 31 * 60_000;
    await svc.launchStatsTick();
    expect(list.mock.calls[list.mock.calls.length - 1][4]).toEqual([]);
  });

  it('while the provider lags, only asks about the launches created before its head', async () => {
    const head = new Date(NOW - 3 * 3_600_000);
    (client.fetchIngestHead as jest.Mock).mockResolvedValue(head);
    list.mockResolvedValue([]);
    await svc.launchStatsTick();
    expect(list).toHaveBeenLastCalledWith(60, 40, 30 * 60, 14 * 60, [], head);
  });

  it('leaves a token whose read failed out of the next batches for 5 minutes, then tries it again', async () => {
    list.mockResolvedValue(targets(1, 2));
    refusing(2);
    await svc.launchStatsTick();

    list.mockResolvedValue([]);
    clock = NOW + 4 * 60_000;
    await svc.launchStatsTick();
    expect(list).toHaveBeenLastCalledWith(60, 40, 30 * 60, 14 * 60, [TOKEN(2)], null);

    clock = NOW + 6 * 60_000;
    await svc.launchStatsTick();
    expect(list).toHaveBeenLastCalledWith(60, 40, 30 * 60, 14 * 60, [], null);
  });

  it('fails the run when three reads in a row fail: that is the provider', async () => {
    list.mockResolvedValue(targets(1, 2, 3, 4, 5));
    refusing(2, 3, 4);
    await expect(svc.launchStatsTick()).rejects.toThrow('API error: 500');
    expect(update.mock.calls.map((c) => c[0])).toEqual([TOKEN(1)]);
    expect(advance).not.toHaveBeenCalled();
  });

  it('sets the third one aside too before it fails, so a longer run of them is passed over the next runs', async () => {
    // Six launches the provider errs on, at the head of the queue, then healthy ones.
    const failing = new Set([1, 2, 3, 4, 5, 6].map(TOKEN));
    holders.mockImplementation(async (token: string) => {
      if (failing.has(token)) throw new Error('API error: 500');
      return [{ address: TOKEN(900), share: 0.25 }];
    });
    /** The queue as the database gives it: the head first, less what is set aside. */
    list.mockImplementation(async (...args: unknown[]) => targets(1, 2, 3, 4, 5, 6, 7, 8).filter((t) => !(args[4] as string[]).includes(t.token)));

    await expect(svc.launchStatsTick()).rejects.toThrow('API error: 500');
    await expect(svc.launchStatsTick()).rejects.toThrow('API error: 500');
    // Third run, within the 5 minutes: the six are aside, the healthy ones are read.
    await expect(svc.launchStatsTick()).resolves.toBe(5 * 60_000);
    expect(update.mock.calls.map((c) => c[0])).toEqual([TOKEN(7), TOKEN(8)]);
  });

  it('does not count failures apart as a run of failures', async () => {
    list.mockResolvedValue(targets(1, 2, 3, 4, 5, 6, 7));
    refusing(1, 3, 5, 7);
    await expect(svc.launchStatsTick()).resolves.toBe(5 * 60_000);
    expect(update.mock.calls.map((c) => c[0])).toEqual([TOKEN(2), TOKEN(4), TOKEN(6)]);
  });

  it('a token set aside by one stream is still read by the other', async () => {
    list.mockResolvedValue(targets(1));
    refusing(1);
    await svc.launchStatsTick();
    jest.spyOn(repo, 'listTokensForStats').mockResolvedValue([TOKEN(1)]);
    const stat = jest.spyOn(repo, 'upsertTokenStat').mockResolvedValue(undefined);
    jest.spyOn(client, 'fetchIngestToken').mockResolvedValue({ holders: 4, decimals: 18, total_supply_raw: '1000000000000000000' });
    await svc.tokenStatsTick();
    expect(stat).toHaveBeenCalledWith(TOKEN(1), 4, '1');
  });

  it('holder counts of the top tokens: goes past the token that fails, and skips it while it is set aside', async () => {
    jest.spyOn(repo, 'listTokensForStats').mockResolvedValue([TOKEN(1), TOKEN(2), TOKEN(3)]);
    const stat = jest.spyOn(repo, 'upsertTokenStat').mockResolvedValue(undefined);
    const detail = jest.spyOn(client, 'fetchIngestToken').mockImplementation(async (token: string) => {
      if (token === TOKEN(2)) throw new Error('API error: 500');
      return { holders: 12, decimals: 18, total_supply_raw: '1000000000000000000' };
    });

    await svc.tokenStatsTick();
    expect(stat.mock.calls.map((c) => c[0])).toEqual([TOKEN(1), TOKEN(3)]);
    expect(stat).toHaveBeenCalledWith(TOKEN(1), 12, '1');

    detail.mockClear();
    await svc.tokenStatsTick();
    expect(detail.mock.calls.map((c) => c[0])).toEqual([TOKEN(1), TOKEN(3)]);
  });

  describe('a new launch without a name', () => {
    let detail: jest.SpyInstance;
    let upsert: jest.SpyInstance;
    let name: jest.SpyInstance;
    beforeEach(() => {
      detail = jest.spyOn(client, 'fetchIngestToken').mockResolvedValue({ address: TOKEN(1), standard: 'erc20', name: 'Signal Cat', symbol: 'SCAT', decimals: 18, transfer_count: 2, holders: 1 });
      upsert = jest.spyOn(repo, 'upsertTokens').mockResolvedValue(1);
      name = jest.spyOn(repo, 'nameLaunches').mockResolvedValue(1);
      holders.mockResolvedValue([{ address: TOKEN(900), share: 0.25 }]);
    });

    it('takes its name from the provider’s page of its token on its first holder read, not 6 to 12 hours later', async () => {
      list.mockResolvedValue([{ token: TOKEN(1), creator: null, curve: null, pool: null, needsName: true }]);
      await svc.launchStatsTick();
      expect(detail).toHaveBeenCalledWith(TOKEN(1));
      expect(upsert).toHaveBeenCalledWith([expect.objectContaining({ address: TOKEN(1), symbol: 'SCAT', name: 'Signal Cat', transfer_count: '2' })]);
      expect(name).toHaveBeenCalledWith([expect.objectContaining({ address: TOKEN(1), symbol: 'SCAT' })]);
      expect(update).toHaveBeenCalledWith(TOKEN(1), 1, 25, null);
    });

    it('asks for nothing more for a launch that has a name, or was read before', async () => {
      list.mockResolvedValue(targets(1));
      await svc.launchStatsTick();
      expect(detail).not.toHaveBeenCalled();
      expect(name).not.toHaveBeenCalled();
    });

    it('still records the holders when the token page cannot be read or says nothing', async () => {
      list.mockResolvedValue([{ token: TOKEN(1), creator: null, curve: null, pool: null, needsName: true }]);
      detail.mockRejectedValueOnce(new Error('API error: 500'));
      await svc.launchStatsTick();
      expect(update).toHaveBeenCalledWith(TOKEN(1), 1, 25, null);
      expect(svc.rejects.take()).toEqual([]);

      detail.mockResolvedValue({ address: TOKEN(1), standard: 'erc20', name: null, symbol: '', transfer_count: 1 });
      await svc.launchStatsTick();
      expect(name).not.toHaveBeenCalled();
      // The provider does not know the token's page.
      detail.mockResolvedValue(null);
      await svc.launchStatsTick();
      expect(name).not.toHaveBeenCalled();
    });

    it('names the launch but leaves the registry alone when the page carries no transfer count', async () => {
      list.mockResolvedValue([{ token: TOKEN(1), creator: null, curve: null, pool: null, needsName: true }]);
      detail.mockResolvedValue({ address: TOKEN(1), standard: 'erc20', name: 'Signal Cat', symbol: 'SCAT' });
      await svc.launchStatsTick();
      expect(name).toHaveBeenCalledWith([expect.objectContaining({ symbol: 'SCAT' })]);
      expect(upsert).not.toHaveBeenCalled();
    });
  });

  it('never pads a supply to an absurd decimals read from a token', async () => {
    jest.spyOn(repo, 'listTokensForStats').mockResolvedValue([TOKEN(1)]);
    const stat = jest.spyOn(repo, 'upsertTokenStat').mockResolvedValue(undefined);
    jest.spyOn(client, 'fetchIngestToken').mockResolvedValue({ holders: 3, decimals: 2_000_000_000, total_supply_raw: '5' });
    await svc.tokenStatsTick();
    // A decimals no token has: the supply cannot be known, and is not stored as the raw amount.
    expect(stat).toHaveBeenCalledWith(TOKEN(1), 3, null);
  });
});
