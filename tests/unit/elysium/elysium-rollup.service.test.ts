/**
 * The rollup builder's pass: one closed day at a time, newest first, with the
 * sender lists only for the days the windows can need; a dirty or unbuilt day
 * is redone; old days are dropped now and then.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ElysiumRollupService } from '../../../src/services/elysium/elysium-rollup.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';
import { ElysiumRollupRepository, RollupDayState } from '../../../src/repositories/prisma/prisma.elysium-rollup.repository';

const NOW = Date.parse('2026-11-10T08:00:00.000Z');
const IDLE = 5 * 60_000;

const day = (d: string, patch: Partial<RollupDayState> = {}): RollupDayState => ({
  day: d,
  built: true,
  dirty: false,
  callers: true,
  senders: true,
  ...patch,
});

/** Every closed day from the first day of the chain to yesterday, built. */
function allBuilt(): RollupDayState[] {
  const out: RollupDayState[] = [];
  for (let t = Date.parse('2026-09-11T00:00:00Z'); t < Date.parse('2026-11-10T00:00:00Z'); t += 86_400_000) {
    out.push(day(new Date(t).toISOString().slice(0, 10)));
  }
  return out;
}

describe('ElysiumRollupService.tick', () => {
  let svc: ElysiumRollupService;
  const states = ElysiumIngestRepository.getInstance();
  const repo = ElysiumRollupRepository.getInstance();
  let listDays: jest.SpyInstance;
  let buildDay: jest.SpyInstance;
  let prune: jest.SpyInstance;

  beforeEach(() => {
    (ElysiumRollupService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumRollupService.getInstance();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(states, 'getState').mockResolvedValue({
      stream: 'tx',
      cursor: new Date(NOW - 60_000),
      rows: 0n,
      backfillDone: true,
      lastError: null,
      updatedAt: new Date(NOW),
    });
    listDays = jest.spyOn(repo, 'listDays').mockResolvedValue(allBuilt());
    buildDay = jest.spyOn(repo, 'buildDay').mockResolvedValue('built');
    prune = jest.spyOn(repo, 'prune').mockResolvedValue(0);
    jest.spyOn(states, 'advance').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('builds nothing when every closed day is built, and comes back in 5 minutes', async () => {
    await expect(svc.tick()).resolves.toBe(IDLE);
    expect(buildDay).not.toHaveBeenCalled();
    expect(listDays).toHaveBeenCalledWith('2026-09-08');
  });

  it('builds the newest missing day first, one per pass, and comes back at once while more wait', async () => {
    listDays.mockResolvedValue(allBuilt().filter((d) => !['2026-11-09', '2026-11-02', '2026-10-01'].includes(d.day)));
    await expect(svc.tick()).resolves.toBe(5_000);
    expect(buildDay).toHaveBeenCalledTimes(1);
    expect(buildDay).toHaveBeenCalledWith('2026-11-09', { callers: true, senders: true });
  });

  it('builds the caller lists for 32 days back and the sender lists for 8', async () => {
    const missing = (d: string) => listDays.mockResolvedValue(allBuilt().filter((x) => x.day !== d));
    missing('2026-11-02');
    await svc.tick();
    expect(buildDay).toHaveBeenLastCalledWith('2026-11-02', { callers: true, senders: true });
    missing('2026-11-01');
    await svc.tick();
    expect(buildDay).toHaveBeenLastCalledWith('2026-11-01', { callers: true, senders: false });
    missing('2026-10-09');
    await svc.tick();
    expect(buildDay).toHaveBeenLastCalledWith('2026-10-09', { callers: true, senders: false });
    missing('2026-10-08');
    await expect(svc.tick()).resolves.toBe(IDLE);
    expect(buildDay).toHaveBeenLastCalledWith('2026-10-08', { callers: false, senders: false });
  });

  it('redoes a dirty day and a day whose build never ended', async () => {
    listDays.mockResolvedValue(
      allBuilt().map((d) => (d.day === '2026-11-05' ? day(d.day, { dirty: true }) : d.day === '2026-10-20' ? day(d.day, { built: false }) : d))
    );
    await expect(svc.tick()).resolves.toBe(5_000);
    expect(buildDay).toHaveBeenCalledWith('2026-11-05', expect.anything());
  });

  it('comes back at once on a day that went dirty during its build, and in 5 minutes when the builder is taken', async () => {
    listDays.mockResolvedValue(allBuilt().filter((d) => d.day !== '2026-11-09'));
    buildDay.mockResolvedValue('dirty');
    await expect(svc.tick()).resolves.toBe(5_000);
    buildDay.mockResolvedValue('busy');
    await expect(svc.tick()).resolves.toBe(IDLE);
  });

  it('does not build yesterday before the tx stream is 10 minutes into today', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-10T00:05:00.000Z'));
    (states.getState as jest.Mock).mockResolvedValue({
      stream: 'tx', cursor: new Date('2026-11-10T00:04:30.000Z'), rows: 0n, backfillDone: true, lastError: null, updatedAt: new Date(NOW),
    });
    listDays.mockResolvedValue(allBuilt().filter((d) => d.day !== '2026-11-09'));
    await expect(svc.tick()).resolves.toBe(IDLE);
    expect(buildDay).not.toHaveBeenCalled();
  });

  it('builds nothing while the tx stream has no cursor', async () => {
    (states.getState as jest.Mock).mockResolvedValue(null);
    listDays.mockResolvedValue([]);
    await expect(svc.tick()).resolves.toBe(IDLE);
    expect(buildDay).not.toHaveBeenCalled();
  });

  it('drops the old days once everything is built, then not again for 6 hours', async () => {
    await svc.tick();
    expect(prune).toHaveBeenCalledWith({ calls: '2026-09-08', callers: '2026-10-07', senders: '2026-10-31' });
    await svc.tick();
    expect(prune).toHaveBeenCalledTimes(1);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 6 * 3_600_000);
    await svc.tick();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('clears its last error after a pass that went through', async () => {
    await svc.tick();
    expect(states.advance).toHaveBeenCalledWith('rollup', { cursor: new Date(NOW) });
  });

  describe('a day whose build fails', () => {
    let recordError: jest.SpyInstance;
    const without = (...days: string[]) => allBuilt().filter((d) => !days.includes(d.day));
    beforeEach(() => {
      recordError = jest.spyOn(states, 'recordError').mockResolvedValue(undefined);
      (states.advance as jest.Mock).mockClear();
    });

    it('is recorded, with its day, and does not clear the builder\'s error', async () => {
      listDays.mockResolvedValue(without('2026-11-09'));
      buildDay.mockRejectedValue(new Error('canceling statement due to statement timeout'));
      await expect(svc.tick()).resolves.toBe(IDLE);
      expect(recordError).toHaveBeenCalledWith('rollup', '2026-11-09: canceling statement due to statement timeout');
      expect(states.advance).not.toHaveBeenCalled();
    });

    it('does not hold the older days: the next pass builds the next one that waits (the newest was tried again every time)', async () => {
      const missing = new Set(['2026-11-09', '2026-11-07', '2026-11-03']);
      listDays.mockImplementation(async () => without(...missing));
      buildDay.mockImplementation(async (d: string) => {
        if (d === '2026-11-09') throw new Error('statement timeout');
        missing.delete(d);
        return 'built';
      });
      // The failure asks to come back at once: other days wait.
      await expect(svc.tick()).resolves.toBe(5_000);
      await svc.tick();
      await svc.tick();
      expect(buildDay.mock.calls.map((c) => c[0])).toEqual(['2026-11-09', '2026-11-07', '2026-11-03']);
      // Its error stays the builder's while the others are built.
      expect(recordError).toHaveBeenCalledTimes(3);
      expect(states.advance).not.toHaveBeenCalled();
    });

    it('is tried again after 5 minutes, then 10, then 20', async () => {
      listDays.mockResolvedValue(without('2026-11-09'));
      buildDay.mockRejectedValue(new Error('statement timeout'));
      let clock = NOW;
      (Date.now as jest.Mock).mockImplementation(() => clock);
      const tries = (): number => buildDay.mock.calls.length;
      await svc.tick();
      clock += 4 * 60_000;
      await svc.tick();
      expect(tries()).toBe(1);
      clock += 2 * 60_000;
      await svc.tick();
      expect(tries()).toBe(2);
      clock += 9 * 60_000;
      await svc.tick();
      expect(tries()).toBe(2);
      clock += 2 * 60_000;
      await svc.tick();
      expect(tries()).toBe(3);
    });

    it('is forgotten once it is built: the builder\'s error is cleared', async () => {
      listDays.mockResolvedValue(without('2026-11-09'));
      buildDay.mockRejectedValueOnce(new Error('statement timeout'));
      let clock = NOW;
      (Date.now as jest.Mock).mockImplementation(() => clock);
      await svc.tick();
      clock += 6 * 60_000;
      buildDay.mockResolvedValue('built');
      await svc.tick();
      expect(states.advance).toHaveBeenCalledWith('rollup', { cursor: new Date(clock) });
    });

    it('does not keep the old days from being dropped', async () => {
      listDays.mockResolvedValue(without('2026-11-09'));
      buildDay.mockRejectedValue(new Error('statement timeout'));
      await svc.tick();
      expect(prune).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps fewer days with ELYSIUM_ROLLUP_KEEP_DAYS: older days are neither built nor kept', async () => {
    process.env.ELYSIUM_ROLLUP_KEEP_DAYS = '20';
    try {
      // Only days older than the 20 kept are missing: nothing to build.
      listDays.mockResolvedValue(allBuilt().filter((d) => d.day >= '2026-10-21'));
      await expect(svc.tick()).resolves.toBe(IDLE);
      expect(buildDay).not.toHaveBeenCalled();
      expect(listDays).toHaveBeenCalledWith('2026-10-21');
      expect(prune).toHaveBeenCalledWith({ calls: '2026-10-21', callers: '2026-10-21', senders: '2026-10-31' });
    } finally {
      delete process.env.ELYSIUM_ROLLUP_KEEP_DAYS;
    }
  });

  it('is switched off by ELYSIUM_ROLLUPS_ENABLED=false', () => {
    expect(ElysiumRollupService.isEnabled()).toBe(true);
    process.env.ELYSIUM_ROLLUPS_ENABLED = 'false';
    expect(ElysiumRollupService.isEnabled()).toBe(false);
    delete process.env.ELYSIUM_ROLLUPS_ENABLED;
  });
});
