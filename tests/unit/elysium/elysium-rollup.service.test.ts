/**
 * The rollup builder's pass: the hours that closed and the window tables that
 * read them, then one closed day at a time, newest first, with the sender
 * lists only for the days the windows can need; a dirty or unbuilt day or
 * hour is redone; old days and hours are dropped now and then.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const readRollupCoverage = jest.fn();
jest.mock('../../../src/services/elysium/elysium-rollup.reader', () => ({
  ...jest.requireActual('../../../src/services/elysium/elysium-rollup.reader'),
  readRollupCoverage: (...args: unknown[]) => readRollupCoverage(...args),
}));

import { ElysiumRollupService } from '../../../src/services/elysium/elysium-rollup.service';
import { ElysiumIngestRepository } from '../../../src/repositories/prisma/prisma.elysium.repository';
import {
  ElysiumRollupRepository,
  RollupDayState,
  RollupHourState,
} from '../../../src/repositories/prisma/prisma.elysium-rollup.repository';
import { ElysiumPartitionRepository } from '../../../src/repositories/prisma/prisma.elysium-partition.repository';
import { ElysiumWindowRepository } from '../../../src/repositories/prisma/prisma.elysium-window.repository';
import { ELYSIUM_GENESIS } from '../../../src/services/elysium/elysium-ingest.util';
import { emptyRollupCoverage, type RollupCoverage } from '../../../src/services/elysium/elysium-rollup.reader';
import { closedRollupHours, HOUR_MS, keptRollupHours, wantedRollupHours } from '../../../src/services/elysium/elysium-rollup.util';

// Ten minutes past the hour: the hour that just ended is closed, and the next close is further than the idle period.
const NOW = Date.parse('2026-11-10T08:10:00.000Z');
const IDLE = 5 * 60_000;
const SOON = 5_000;

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

/** Every hour the builder wants at `now` and that the stream (a minute behind `now`) is done with, built. */
function allHoursBuilt(now = NOW): RollupHourState[] {
  return closedRollupHours(new Date(now - 60_000), new Date(now), ELYSIUM_GENESIS).map((hour) => ({ hour, built: true, dirty: false }));
}

describe('ElysiumRollupService.tick', () => {
  let svc: ElysiumRollupService;
  const states = ElysiumIngestRepository.getInstance();
  const repo = ElysiumRollupRepository.getInstance();
  const windows = ElysiumWindowRepository.getInstance();
  let heldFrom: jest.SpyInstance;
  let listDays: jest.SpyInstance;
  let buildDay: jest.SpyInstance;
  let prune: jest.SpyInstance;
  let listHours: jest.SpyInstance;
  let buildHour: jest.SpyInstance;
  let pruneHours: jest.SpyInstance;
  let refresh: jest.SpyInstance;
  let reclassify: jest.SpyInstance;

  beforeEach(() => {
    (ElysiumRollupService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumRollupService.getInstance();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    // elysium_tx holds every day (no keep set), unless a test says where it starts.
    heldFrom = jest.spyOn(ElysiumPartitionRepository.getInstance(), 'floorMs').mockResolvedValue(null);
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
    listHours = jest.spyOn(repo, 'listHours').mockImplementation(async () => allHoursBuilt(Date.now()));
    buildHour = jest.spyOn(repo, 'buildHour').mockResolvedValue('built');
    pruneHours = jest.spyOn(repo, 'pruneHours').mockResolvedValue(0);
    refresh = jest.spyOn(windows, 'refresh').mockResolvedValue('refreshed');
    reclassify = jest.spyOn(windows, 'reclassify').mockResolvedValue(new Map());
    jest.spyOn(states, 'advance').mockResolvedValue(undefined);
    // The window tables are their own block of tests: switched off for the others.
    process.env.ELYSIUM_WINDOWS_ENABLED = 'false';
    readRollupCoverage.mockReset();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ELYSIUM_WINDOWS_ENABLED;
  });

  it('builds nothing when every closed day is built, and comes back in 5 minutes', async () => {
    await expect(svc.tick()).resolves.toBe(IDLE);
    expect(buildDay).not.toHaveBeenCalled();
    expect(listDays).toHaveBeenCalledWith('2026-09-08');
  });

  it('builds the newest missing day first, one per pass, and comes back at once: more wait, and the window tables follow a day', async () => {
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
    // Even the last day that waited: the pass that follows brings the window tables to it.
    await expect(svc.tick()).resolves.toBe(SOON);
    expect(buildDay).toHaveBeenLastCalledWith('2026-10-08', { callers: false, senders: false });
  });

  it('never builds a day or an hour elysium_tx no longer holds: its rollup is all that is left of it', async () => {
    // Old days were dropped under a keep: the table starts on 2026-11-05. Two days wait, one on each side.
    heldFrom.mockResolvedValue(Date.parse('2026-11-05T00:00:00.000Z'));
    listDays.mockResolvedValue(allBuilt().map((d) => (d.day === '2026-11-03' || d.day === '2026-11-06' ? { ...d, dirty: true } : d)));
    await svc.tick();
    expect(buildDay).toHaveBeenCalledTimes(1);
    expect(buildDay.mock.calls[0][0]).toBe('2026-11-06');
    buildDay.mockClear();
    listDays.mockResolvedValue(allBuilt().map((d) => (d.day === '2026-11-03' ? { ...d, dirty: true } : d)));
    await expect(svc.tick()).resolves.toBe(IDLE);
    expect(buildDay).not.toHaveBeenCalled();
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
    listHours.mockImplementation(async () =>
      closedRollupHours(new Date('2026-11-10T00:04:30.000Z'), new Date(Date.now()), ELYSIUM_GENESIS).map((hour) => ({ hour, built: true, dirty: false }))
    );
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

  it('a drop of the old days that fails does not end the pass, and is tried again half an hour later (it counted as done for 6 hours)', async () => {
    listDays.mockResolvedValue(allBuilt().slice(0, -1)); // yesterday waits to be built
    prune.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    await svc.tick();
    expect(buildDay).toHaveBeenCalledWith('2026-11-09', expect.anything());
    expect(prune).toHaveBeenCalledTimes(1);

    (Date.now as jest.Mock).mockReturnValue(NOW + 29 * 60_000);
    await svc.tick();
    expect(prune).toHaveBeenCalledTimes(1);
    (Date.now as jest.Mock).mockReturnValue(NOW + 31 * 60_000);
    await svc.tick();
    expect(prune).toHaveBeenCalledTimes(2);
    // That one went through: not again for 6 hours.
    (Date.now as jest.Mock).mockReturnValue(NOW + 5 * 3_600_000);
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

  describe('hours', () => {
    const LAST = Date.parse('2026-11-10T07:00:00.000Z');
    const built = (...except: number[]): RollupHourState[] => allHoursBuilt().filter((h) => !except.includes(h.hour));

    it('builds the hour that just closed, and wakes for the next close when nothing else waits', async () => {
      listHours.mockResolvedValue(built(LAST));
      await expect(svc.tick()).resolves.toBe(IDLE);
      expect(buildHour).toHaveBeenCalledTimes(1);
      expect(buildHour).toHaveBeenCalledWith(LAST);
      // 08:59:00: the hour in progress closes at 09:03:05.
      (Date.now as jest.Mock).mockReturnValue(Date.parse('2026-11-10T08:59:00.000Z'));
      listHours.mockImplementation(async () => allHoursBuilt(Date.parse('2026-11-10T08:59:00.000Z')));
      await expect(svc.tick()).resolves.toBe(4 * 60_000 + 5_000);
    });

    it('does not build an hour before the tx stream is three minutes past its end', async () => {
      (Date.now as jest.Mock).mockReturnValue(Date.parse('2026-11-10T08:02:00.000Z'));
      (states.getState as jest.Mock).mockResolvedValue({
        stream: 'tx', cursor: new Date('2026-11-10T08:01:30.000Z'), rows: 0n, backfillDone: true, lastError: null, updatedAt: new Date(NOW),
      });
      listHours.mockResolvedValue(built(LAST));
      // The hour has not been over for three minutes: nothing to wait the cursor for either.
      await expect(svc.tick()).resolves.toBe(65_000);
      expect(buildHour).not.toHaveBeenCalled();
    });

    it('comes back 20 s later when an hour only waits for the cursor, seconds behind; not for a stream that stands still', async () => {
      // 08:03:05, the pass of "end of the hour + 3 min": the cursor, moved every 30 s, is at 08:02:50.
      (Date.now as jest.Mock).mockReturnValue(Date.parse('2026-11-10T08:03:05.000Z'));
      const cursorAt = (iso: string): void => {
        (states.getState as jest.Mock).mockResolvedValue({ stream: 'tx', cursor: new Date(iso), rows: 0n, backfillDone: true, lastError: null, updatedAt: new Date(NOW) });
        listHours.mockImplementation(async () => closedRollupHours(new Date(iso), new Date(Date.now()), ELYSIUM_GENESIS).map((hour) => ({ hour, built: true, dirty: false })));
      };
      cursorAt('2026-11-10T08:02:50.000Z');
      await expect(svc.tick()).resolves.toBe(20_000);
      expect(buildHour).not.toHaveBeenCalled();
      // The cursor passed: built, and the next pass is the next close.
      cursorAt('2026-11-10T08:03:01.000Z');
      listHours.mockResolvedValue(built(LAST));
      await expect(svc.tick()).resolves.toBe(IDLE);
      expect(buildHour).toHaveBeenCalledWith(LAST);
      // A stream stopped for an hour is not polled every 20 s.
      cursorAt('2026-11-10T07:02:00.000Z');
      await expect(svc.tick()).resolves.toBe(IDLE);
    });

    it('a pass over the hours that cannot start is recorded, and the day is still built', async () => {
      const recordError = jest.spyOn(states, 'recordError').mockResolvedValue(undefined);
      listHours.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
      listDays.mockResolvedValue(allBuilt().slice(0, -1));
      await svc.tick();
      expect(buildDay).toHaveBeenCalledTimes(1);
      expect(recordError).toHaveBeenCalledWith('rollup', 'hours: timeout exceeded when trying to connect');
    });

    it('redoes a dirty hour and an hour whose build never ended', async () => {
      const dirty = Date.parse('2026-11-10T03:00:00.000Z');
      const unfinished = Date.parse('2026-11-09T22:00:00.000Z');
      listHours.mockResolvedValue(
        allHoursBuilt().map((h) => (h.hour === dirty ? { ...h, dirty: true } : h.hour === unfinished ? { ...h, built: false } : h))
      );
      await svc.tick();
      expect(buildHour.mock.calls.map((c) => c[0]).sort()).toEqual([unfinished, dirty]);
    });

    it('builds a dozen hours a pass, the most pressing first, and comes back at once for the rest', async () => {
      listHours.mockResolvedValue([]);
      await expect(svc.tick()).resolves.toBe(SOON);
      expect(buildHour).toHaveBeenCalledTimes(12);
      const wanted = wantedRollupHours(new Date(NOW), ELYSIUM_GENESIS);
      expect(buildHour.mock.calls.map((c) => c[0])).toEqual(wanted.slice(0, 12));
      // The hours right after the start of the 7 and 30 day windows, and the latest ones.
      expect(buildHour).toHaveBeenCalledWith(Date.parse('2026-11-03T09:00:00.000Z'));
      expect(buildHour).toHaveBeenCalledWith(Date.parse('2026-10-11T09:00:00.000Z'));
      expect(buildHour).toHaveBeenCalledWith(LAST);
    });

    it('stops the pass on a builder that is taken, and comes back at once', async () => {
      listHours.mockResolvedValue([]);
      buildHour.mockResolvedValue('busy');
      await expect(svc.tick()).resolves.toBe(SOON);
      expect(buildHour).toHaveBeenCalledTimes(1);
    });

    it('an hour whose build fails is recorded, left alone for 5 minutes, and does not hold the others', async () => {
      const recordError = jest.spyOn(states, 'recordError').mockResolvedValue(undefined);
      const bad = Date.parse('2026-11-10T05:00:00.000Z');
      listHours.mockResolvedValue(built(bad, LAST));
      buildHour.mockImplementation(async (hour: number) => {
        if (hour === bad) throw new Error('canceling statement due to statement timeout');
        return 'built';
      });
      let clock = NOW;
      (Date.now as jest.Mock).mockImplementation(() => clock);
      await svc.tick();
      expect(buildHour.mock.calls.map((c) => c[0])).toEqual([LAST, bad]);
      expect(recordError).toHaveBeenCalledWith('rollup', '2026-11-10T05:00:00.000Z: canceling statement due to statement timeout');
      listHours.mockResolvedValue(built(bad));
      clock += 4 * 60_000;
      await svc.tick();
      expect(buildHour).toHaveBeenCalledTimes(2);
      clock += 2 * 60_000;
      await svc.tick();
      expect(buildHour).toHaveBeenCalledTimes(3);
    });

    it('drops the hours it no longer wants once an hour, keeping the wanted ones and a few before them', async () => {
      await svc.tick();
      expect(pruneHours).toHaveBeenCalledTimes(1);
      const [before, keep] = pruneHours.mock.calls[0] as [number, number[]];
      // Everything from 53 hours back is kept whatever it is; older hours only when wanted.
      expect(before).toBe(Date.parse('2026-11-10T08:00:00.000Z') - 53 * HOUR_MS);
      expect(new Set(keep)).toEqual(keptRollupHours(new Date(NOW), ELYSIUM_GENESIS));
      await svc.tick();
      expect(pruneHours).toHaveBeenCalledTimes(1);
      (Date.now as jest.Mock).mockReturnValue(NOW + HOUR_MS);
      listHours.mockImplementation(async () => allHoursBuilt(NOW + HOUR_MS));
      await svc.tick();
      expect(pruneHours).toHaveBeenCalledTimes(2);
    });

    it('builds the hours before the day: a day takes minutes, and every window waits on the hours', async () => {
      listHours.mockResolvedValue(built(LAST));
      listDays.mockResolvedValue(allBuilt().slice(0, -1));
      await svc.tick();
      expect(buildHour.mock.invocationCallOrder[0]).toBeLessThan(buildDay.mock.invocationCallOrder[0]);
    });
  });

  describe('window tables', () => {
    const BUILT_AT = 1_762_000_000_000;
    /** Every closed day and every wanted hour built, and the tables as given. */
    function coverageWith(states7?: Partial<NonNullable<ReturnType<RollupCoverage['windows']['get']>>>): RollupCoverage {
      const coverage = emptyRollupCoverage();
      for (const d of allBuilt()) {
        coverage.days.set(d.day, { callers: true, senders: true });
        (coverage.built.days as Map<string, number>).set(d.day, BUILT_AT);
      }
      for (const h of allHoursBuilt()) {
        coverage.hours.add(h.hour);
        (coverage.built.hours as Map<number, number>).set(h.hour, BUILT_AT);
      }
      if (states7) {
        coverage.windows.set(7, {
          span: 7, version: '5', ready: true, epoch: '0', baseDays: [], coverDays: [], coverHours: [], refreshedAt: NOW - 60_000, ...states7,
        });
      }
      return coverage;
    }
    const days7 = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'].map((day) => ({ day, at: BUILT_AT }));
    /** The whole hours of a 7-day window ending at 08:10: 09:00 to midnight on its first day, 00:00 to 08:00 today. */
    const hours7 = (): Array<{ hour: number; at: number }> => {
      const out: Array<{ hour: number; at: number }> = [];
      for (let h = Date.parse('2026-11-03T09:00:00Z'); h < Date.parse('2026-11-04T00:00:00Z'); h += HOUR_MS) out.push({ hour: h, at: BUILT_AT });
      for (let h = Date.parse('2026-11-10T00:00:00Z'); h < Date.parse('2026-11-10T08:00:00Z'); h += HOUR_MS) out.push({ hour: h, at: BUILT_AT });
      return out;
    };

    beforeEach(() => {
      delete process.env.ELYSIUM_WINDOWS_ENABLED;
    });

    it('starts each table from nothing, with its base: the days and hours a window of its span holds now', async () => {
      readRollupCoverage.mockResolvedValue(coverageWith());
      await svc.tick();
      expect(refresh.mock.calls.map((c) => c[0])).toEqual([1, 7, 30]);
      const [, target7, opts7] = refresh.mock.calls[1] as [number, { days: unknown[]; hours: unknown[] }, { rebase: boolean }];
      expect(target7).toEqual({ days: days7, hours: hours7() });
      expect(opts7).toEqual({ rebase: true });
      // 24 hours: no whole day, 23 whole hours.
      expect((refresh.mock.calls[0][1] as { days: unknown[]; hours: unknown[] }).days).toEqual([]);
      expect((refresh.mock.calls[0][1] as { days: unknown[]; hours: unknown[] }).hours).toHaveLength(23);
      expect((refresh.mock.calls[2][1] as { days: unknown[] }).days).toHaveLength(29);
    });

    it('waits for the hours: no table is touched while a pass leaves hours to build', async () => {
      readRollupCoverage.mockResolvedValue(coverageWith());
      listHours.mockResolvedValue([]);
      await expect(svc.tick()).resolves.toBe(SOON);
      expect(buildHour).toHaveBeenCalledTimes(12);
      expect(refresh).not.toHaveBeenCalled();
      listHours.mockImplementation(async () => allHoursBuilt());
      await svc.tick();
      expect(refresh).toHaveBeenCalledTimes(3);
    });

    it('reads the rollups` state on the writers` pool', async () => {
      readRollupCoverage.mockResolvedValue(coverageWith());
      await svc.tick();
      expect(readRollupCoverage).toHaveBeenCalledWith(expect.any(Date), { db: expect.anything() });
    });

    it('leaves alone a table that stands for what a window holds now', async () => {
      readRollupCoverage.mockResolvedValue(coverageWith({ baseDays: days7, coverDays: days7, coverHours: hours7() }));
      await svc.tick();
      expect(refresh.mock.calls.map((c) => c[0])).toEqual([1, 30]);
    });

    it('refreshes the edges, not the base, when an hour closed', async () => {
      readRollupCoverage.mockResolvedValue(coverageWith({ baseDays: days7, coverDays: days7, coverHours: hours7().slice(0, -1) }));
      await svc.tick();
      const call = refresh.mock.calls.find((c) => c[0] === 7) as [number, unknown, { rebase: boolean }];
      expect(call[2]).toEqual({ rebase: false });
    });

    it('does not start a table while a day of its window waits for its rollup, and starts the others', async () => {
      listDays.mockResolvedValue(allBuilt().filter((d) => d.day !== '2026-10-20'));
      const coverage = coverageWith();
      coverage.days.delete('2026-10-20');
      (coverage.built.days as Map<string, number>).delete('2026-10-20');
      readRollupCoverage.mockResolvedValue(coverage);
      await svc.tick();
      // 2026-10-20 is in the 30-day window only.
      expect(refresh.mock.calls.map((c) => c[0])).toEqual([1, 7]);
    });

    it('comes back at once when a table could not be brought to its target', async () => {
      readRollupCoverage.mockResolvedValue(coverageWith());
      refresh.mockResolvedValue('stale');
      await expect(svc.tick()).resolves.toBe(SOON);
      refresh.mockResolvedValue('busy');
      await expect(svc.tick()).resolves.toBe(SOON);
      refresh.mockResolvedValue('refreshed');
      await expect(svc.tick()).resolves.toBe(IDLE);
    });

    it('looks at the classes again every five minutes, in one pass for all the tables', async () => {
      readRollupCoverage.mockResolvedValue(coverageWith());
      let clock = NOW;
      (Date.now as jest.Mock).mockImplementation(() => clock);
      await svc.tick();
      expect(reclassify).toHaveBeenCalledTimes(1);
      clock += 4 * 60_000;
      await svc.tick();
      expect(reclassify).toHaveBeenCalledTimes(1);
      clock += 61_000;
      await svc.tick();
      expect(reclassify).toHaveBeenCalledTimes(2);
      // A pass that found the builder taken is tried again on the next one.
      reclassify.mockResolvedValue('busy');
      clock += 5 * 60_000;
      await svc.tick();
      await svc.tick();
      expect(reclassify).toHaveBeenCalledTimes(4);
    });

    it('a table whose upkeep fails is recorded, does not hold the others, and does not keep the days from being built', async () => {
      const recordError = jest.spyOn(states, 'recordError').mockResolvedValue(undefined);
      readRollupCoverage.mockResolvedValue(coverageWith());
      refresh.mockImplementation(async (span: number) => {
        if (span === 7) throw new Error('canceling statement due to statement timeout');
        return 'refreshed';
      });
      // A day older than every window waits for its rollup.
      listDays.mockResolvedValue(allBuilt().filter((d) => d.day !== '2026-09-20'));
      await svc.tick();
      expect(refresh.mock.calls.map((c) => c[0])).toEqual([1, 7, 30]);
      expect(buildDay).toHaveBeenCalledWith('2026-09-20', expect.anything());
      expect(recordError).toHaveBeenCalledWith('rollup', 'window 7: canceling statement due to statement timeout');
    });

    it('leaves the tables as they are when the rollups` state cannot be read, and still builds the days', async () => {
      readRollupCoverage.mockRejectedValue(new Error('ELYSIUM_ROLLUP_COVERAGE_UNREADABLE'));
      listDays.mockResolvedValue(allBuilt().slice(0, -1));
      await expect(svc.tick()).resolves.toBe(SOON);
      expect(refresh).not.toHaveBeenCalled();
      expect(buildDay).toHaveBeenCalledTimes(1);
    });

    it('a table that keeps failing is left alone for 5 minutes, then 10: not started again on every pass', async () => {
      jest.spyOn(states, 'recordError').mockResolvedValue(undefined);
      readRollupCoverage.mockResolvedValue(coverageWith());
      refresh.mockImplementation(async (span: number) => {
        if (span === 30) throw new Error('canceling statement due to statement timeout');
        return 'refreshed';
      });
      let clock = NOW;
      (Date.now as jest.Mock).mockImplementation(() => clock);
      const tries = (): number => refresh.mock.calls.filter((c) => c[0] === 30).length;
      await svc.tick();
      expect(tries()).toBe(1);
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
      refresh.mockResolvedValue('refreshed');
      await svc.tick();
      expect(tries()).toBe(3);
      // It went through: the builder's error is cleared.
      expect(states.advance).toHaveBeenLastCalledWith('rollup', { cursor: new Date(clock) });
    });

    it('the pass over the classes that fails is left alone the same way', async () => {
      const recordError = jest.spyOn(states, 'recordError').mockResolvedValue(undefined);
      readRollupCoverage.mockResolvedValue(coverageWith());
      reclassify.mockRejectedValue(new Error('lock timeout'));
      let clock = NOW;
      (Date.now as jest.Mock).mockImplementation(() => clock);
      await svc.tick();
      expect(recordError).toHaveBeenCalledWith('rollup', 'window classes: lock timeout');
      clock += 4 * 60_000;
      await svc.tick();
      expect(reclassify).toHaveBeenCalledTimes(1);
      clock += 2 * 60_000;
      await svc.tick();
      expect(reclassify).toHaveBeenCalledTimes(2);
    });

    it('a day whose build keeps failing is not waited for: the tables are made without it', async () => {
      const failing = '2026-10-20';
      jest.spyOn(states, 'recordError').mockResolvedValue(undefined);
      listDays.mockResolvedValue(allBuilt().filter((d) => d.day !== failing));
      buildDay.mockRejectedValue(new Error('statement timeout'));
      const coverage = coverageWith();
      coverage.days.delete(failing);
      (coverage.built.days as Map<string, number>).delete(failing);
      readRollupCoverage.mockResolvedValue(coverage);
      // First pass: the day is still being tried, the 30-day table waits for it.
      await svc.tick();
      expect(refresh.mock.calls.map((c) => c[0])).toEqual([1, 7]);
      // Its build failed: on the next pass the table is made from the 28 days that are built.
      await svc.tick();
      const last = refresh.mock.calls[refresh.mock.calls.length - 1] as [number, { days: unknown[] }];
      expect(last[0]).toBe(30);
      expect(last[1].days).toHaveLength(28);
    });

    it('does nothing to the tables when they are switched off', async () => {
      process.env.ELYSIUM_WINDOWS_ENABLED = 'false';
      await svc.tick();
      expect(readRollupCoverage).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(reclassify).not.toHaveBeenCalled();
    });
  });

  it('is switched off by ELYSIUM_ROLLUPS_ENABLED=false', () => {
    expect(ElysiumRollupService.isEnabled()).toBe(true);
    process.env.ELYSIUM_ROLLUPS_ENABLED = 'false';
    expect(ElysiumRollupService.isEnabled()).toBe(false);
    delete process.env.ELYSIUM_ROLLUPS_ENABLED;
  });
});
