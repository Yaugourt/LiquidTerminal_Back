/**
 * A token whose holder figures the provider refuses used to end the run where it stood, and the
 * same token came first on the next run: the tokens behind it were never read (2026-11-11).
 * It is now counted, left alone for 30 minutes, and the run goes on. Three unreadable tokens in
 * a row is the provider failing: the run fails and the stream backs off, as before.
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
  const refusing = (...ns: number[]): void => {
    const bad = new Set(ns.map(TOKEN));
    holders.mockImplementation(async (token: string) => {
      if (bad.has(token)) throw new Error('API error: 404 Not Found');
      return [{ address: TOKEN(900), share: 0.25 }];
    });
  };

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Internals;
    svc.stopped = false;
    svc.throttle = { wait: async () => undefined };
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
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
      { stream: 'launchstats', reason: 'token-unreadable', count: 1, sample: `${TOKEN(2)} API error: 404 Not Found` },
    ]);
  });

  it('leaves the token out of the next batches for 30 minutes, then tries it again', async () => {
    list.mockResolvedValue(targets(1, 2));
    refusing(2);
    await svc.launchStatsTick();

    list.mockResolvedValue([]);
    clock = NOW + 10 * 60_000;
    await svc.launchStatsTick();
    expect(list).toHaveBeenLastCalledWith(60, 40, 30 * 60, 14 * 60, [TOKEN(2)]);

    clock = NOW + 31 * 60_000;
    await svc.launchStatsTick();
    expect(list).toHaveBeenLastCalledWith(60, 40, 30 * 60, 14 * 60, []);
  });

  it('fails the run when three tokens in a row cannot be read: that is the provider', async () => {
    list.mockResolvedValue(targets(1, 2, 3, 4, 5));
    refusing(2, 3, 4);
    await expect(svc.launchStatsTick()).rejects.toThrow('API error: 404');
    expect(update.mock.calls.map((c) => c[0])).toEqual([TOKEN(1)]);
    expect(advance).not.toHaveBeenCalled();
  });

  it('does not count failures apart as a run of failures', async () => {
    list.mockResolvedValue(targets(1, 2, 3, 4, 5, 6, 7));
    refusing(1, 3, 5, 7);
    await expect(svc.launchStatsTick()).resolves.toBe(5 * 60_000);
    expect(update.mock.calls.map((c) => c[0])).toEqual([TOKEN(2), TOKEN(4), TOKEN(6)]);
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

  it('never pads a supply to an absurd decimals read from a token', async () => {
    jest.spyOn(repo, 'listTokensForStats').mockResolvedValue([TOKEN(1)]);
    const stat = jest.spyOn(repo, 'upsertTokenStat').mockResolvedValue(undefined);
    jest.spyOn(client, 'fetchIngestToken').mockResolvedValue({ holders: 3, decimals: 2_000_000_000, total_supply_raw: '5' });
    await svc.tokenStatsTick();
    // Unknown decimals: the raw amount is kept as it is, as for a token that gives none.
    expect(stat).toHaveBeenCalledWith(TOKEN(1), 3, '5');
  });
});
