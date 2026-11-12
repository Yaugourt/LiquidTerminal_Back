/**
 * The daily comparison of elysium_tx with the provider's own figures (2026-11-11): when a day
 * is compared, what makes it "differing", when it is read again, in which order, and where the
 * re-read stops. The statements themselves run on a real Postgres in the step's harness
 * (check-db.ts: a day damaged three ways comes back, table for table, to a whole ingestion).
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import { ElysiumDayCheckService, daysToCheck, isProviderFailure, type DayCheckIo } from '../../../src/services/elysium/elysium-day-check.service';
import { ElysiumCheckRepository, type DayCheckRow, type DayCounts } from '../../../src/repositories/prisma/prisma.elysium-check.repository';
import { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';
import type { TxRow } from '../../../src/services/elysium/elysium-ingest.util';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const MIN = 60_000;
const DAY = '2026-11-10';
const DAY_START = Date.parse(`${DAY}T00:00:00.000Z`);
const GENESIS = new Date('2026-09-11T11:55:00Z');

describe('the days to compare', () => {
  const at = (iso: string): number => Date.parse(iso);
  it('are the last 7 closed days, oldest first', () => {
    expect(daysToCheck(at('2026-11-11T12:00:00Z'), 7, GENESIS)).toEqual([
      '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10',
    ]);
  });
  it('leave a day out until the stream and the provider are 10 minutes past its end', () => {
    expect(daysToCheck(at('2026-11-11T00:09:59Z'), 2, GENESIS)).toEqual(['2026-11-08', '2026-11-09']);
    expect(daysToCheck(at('2026-11-11T00:10:00Z'), 2, GENESIS)).toEqual(['2026-11-09', '2026-11-10']);
  });
  it('never go before the chain’s first day', () => {
    expect(daysToCheck(at('2026-09-13T06:00:00Z'), 7, GENESIS)).toEqual(['2026-09-11', '2026-09-12']);
    expect(daysToCheck(at('2026-09-11T20:00:00Z'), 7, GENESIS)).toEqual([]);
  });
});

describe('the daily check', () => {
  const repo = ElysiumCheckRepository.getInstance();
  let clock: number;
  let rejects: IngestRejects;
  let io: jest.Mocked<DayCheckIo>;
  let svc: ElysiumDayCheckService;
  /** elysium_day_check, in memory. */
  let table: Map<string, DayCheckRow>;
  /** What the provider counts for the day. */
  let theirs: DayCounts;
  /** elysium_tx, in memory: our non-spam rows per ten-minute slot (the 10 spam and 50 bridge rows sit in slot 0). */
  let slots: number[];
  /** A day rollup that is built and clean says the same as the table, unless a test says otherwise. */
  const ours = (): DayCounts => ({ txs: slots.reduce((a, b) => a + b, 0), spam: 10, bridge: 50 });
  let slotsRead: number[];
  const tx = (n: number, slot: number): TxRow => ({
    tx_hash: `0x${n.toString(16).padStart(64, '0')}`,
    block_number: String(n),
    block_time: new Date(DAY_START + slot * 10 * MIN + 1000).toISOString(),
    from_addr: `0x${'a'.repeat(40)}`,
    to_addr: `0x${'b'.repeat(40)}`,
    contract_address: null,
    method_id: null,
    tx_type: '0x2',
    gas_used: '21000',
    fee_wei: '21000',
    success: true,
    is_spam: false,
  });
  /** The provider lists this many rows we lack, per slot. */
  let missing: Map<number, number>;
  const slotOf = (start: Date): number => Math.round((start.getTime() - DAY_START) / (10 * MIN));
  const row = (over: Partial<DayCheckRow> = {}): DayCheckRow => ({
    day: DAY, provider: theirs, ours: ours(), status: 'ok', checkedAt: new Date(clock), gapSince: null, progress: null,
    rereads: 0, rowsAdded: 0, rowsCorrected: 0, rowsRemoved: 0, repairedAt: null, ...over,
  });

  beforeEach(() => {
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    rejects = new IngestRejects();
    table = new Map();
    slots = new Array<number>(144).fill(7);
    theirs = ours(); // 1,008 transactions, 10 spam, 50 bridge
    slotsRead = [];
    missing = new Map();
    io = {
      ensureRunning: jest.fn(),
      wait: jest.fn().mockResolvedValue(undefined),
      head: jest.fn().mockResolvedValue(new Date(NOW - 5_000)),
      txCursor: jest.fn().mockResolvedValue(new Date(NOW - 15_000)),
      fetchDaily: jest.fn().mockImplementation(async () => [{ day: DAY, ...theirs }]),
      pageTxs: jest.fn().mockImplementation(async (start: Date, _end: Date, onPage: (rows: TxRow[]) => Promise<void>) => {
        const slot = slotOf(start);
        slotsRead.push(slot);
        await onPage(Array.from({ length: missing.get(slot) ?? 0 }, (_, i) => tx(slot * 1000 + i, slot)));
      }),
      insertTxs: jest.fn().mockImplementation(async (rows: TxRow[]) => {
        for (const r of rows) slots[slotOf(new Date(Date.parse(r.block_time) - 1000))] += 1;
        return rows.length;
      }),
      txListed: jest.fn().mockResolvedValue(true),
      rejects,
    };
    jest.spyOn(repo, 'listChecks').mockImplementation(async () => [...table.values()].map((r) => ({ ...r })));
    jest.spyOn(repo, 'ourDayCounts').mockImplementation(async () => ours());
    const slotCount = (slot: number): DayCounts => ({ txs: slots[slot], spam: slot === 0 ? 10 : 0, bridge: slot === 0 ? 50 : 0 });
    jest.spyOn(repo, 'slotCounts').mockImplementation(async () => slots.map((_, slot) => slotCount(slot)));
    jest.spyOn(repo, 'rangeCounts').mockImplementation(async (start: Date) => slotCount(slotOf(start)));
    jest.spyOn(repo, 'applyTxFlags').mockResolvedValue(0);
    jest.spyOn(repo, 'txHashesBetween').mockResolvedValue([]);
    jest.spyOn(repo, 'removeTxs').mockImplementation(async (hashes) => hashes.length);
    jest.spyOn(repo, 'saveComparison').mockImplementation(async (day, provider, mine, status) => {
      const prev = table.get(day);
      table.set(day, row({
        ...prev, day, provider, ours: mine, status,
        gapSince: status === 'ok' ? null : (prev?.gapSince ?? new Date(clock)),
        progress: status === 'ok' || status === 'gap' ? null : (prev?.progress ?? null),
      }));
    });
    jest.spyOn(repo, 'saveProgress').mockImplementation(async (day, patch) => {
      const prev = table.get(day) as DayCheckRow;
      table.set(day, {
        ...prev, status: patch.status, progress: patch.progress, ours: patch.ours ?? prev.ours,
        rowsAdded: prev.rowsAdded + patch.added, rowsCorrected: prev.rowsCorrected + patch.corrected, rowsRemoved: prev.rowsRemoved + patch.removed,
        rereads: prev.rereads + (patch.wholeReread ? 1 : 0),
        gapSince: patch.status === 'ok' ? null : prev.gapSince,
        repairedAt: patch.status === 'ok' ? new Date(clock) : prev.repairedAt,
      });
    });
    svc = new ElysiumDayCheckService(io);
  });
  afterEach(() => jest.restoreAllMocks());

  const only = (): void => {
    // Only the last closed day in these tests: the six before it are equal already.
    for (const d of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']) table.set(d, row({ day: d }));
  };

  it('waits while the provider’s head is not known: nothing says its day is whole', async () => {
    io.head.mockResolvedValue(null);
    expect(await svc.tick()).toBe(5 * MIN);
    expect(io.fetchDaily).not.toHaveBeenCalled();
  });

  it('records a day equal to the provider as ok, with one read of its figures, and comes back in 30 minutes', async () => {
    only();
    expect(await svc.tick()).toBe(30 * MIN);
    expect(io.fetchDaily).toHaveBeenCalledTimes(1);
    expect(io.fetchDaily).toHaveBeenCalledWith(9);
    expect(table.get(DAY)?.status).toBe('ok');
    expect(io.pageTxs).not.toHaveBeenCalled();
  });

  it('once every day is equal, reads the provider’s figures again only every 6 hours, and counts nothing again', async () => {
    only();
    await svc.tick();
    (repo.ourDayCounts as jest.Mock).mockClear();
    clock += 30 * MIN;
    await svc.tick();
    expect(io.fetchDaily).toHaveBeenCalledTimes(1);
    clock += 6 * 60 * MIN;
    await svc.tick();
    expect(io.fetchDaily).toHaveBeenCalledTimes(2);
    expect(repo.ourDayCounts).not.toHaveBeenCalled();
  });

  it('looks at a day again when the provider revises it', async () => {
    only();
    await svc.tick();
    theirs = { ...theirs, spam: 12, txs: theirs.txs - 2 };
    clock += 6 * 60 * MIN;
    await svc.tick();
    expect(table.get(DAY)?.status).toBe('gap');
    expect(rejects.take()).toEqual([expect.objectContaining({ stream: 'check', reason: 'day-gap', count: 1 })]);
  });

  describe('a day with a hole', () => {
    beforeEach(() => {
      only();
      // Two empty slots in a row: the 14 rows we lack, which the provider counts and lists.
      slots[80] = 0;
      slots[81] = 0;
      missing.set(80, 7).set(81, 7);
    });

    it('is marked as differing and counted once, and is not read again before the difference has lasted 30 minutes', async () => {
      expect(await svc.tick()).toBe(5 * MIN);
      expect(table.get(DAY)?.status).toBe('gap');
      for (let i = 0; i < 5; i++) {
        clock += 5 * MIN;
        await svc.tick();
      }
      expect(io.pageTxs).not.toHaveBeenCalled();
      expect(rejects.take()).toEqual([expect.objectContaining({ reason: 'day-gap', count: 1, sample: expect.stringContaining('ours 994 txs') })]);
    });

    it('reads the emptiest slots first and stops as soon as the day is equal: 2 slots of 144', async () => {
      await svc.tick();
      clock += 30 * MIN;
      await svc.tick();

      expect(slotsRead).toEqual([80, 81]);
      expect(table.get(DAY)).toMatchObject({ status: 'ok', rowsAdded: 14, progress: null, ours: { txs: 1008 } });
      expect(table.get(DAY)?.repairedAt).not.toBeNull();
    });

    it('goes on where it stopped when a run is out of time', async () => {
      // Every slot but the first (which holds the spam) is empty here, so the order is the clock's from
      // the second slot on; the rows we lack are at the end of the day.
      slots.fill(0);
      theirs = { ...theirs, txs: 40 };
      for (const d of table.values()) d.provider = d.day === DAY ? theirs : d.provider;
      missing.clear();
      missing.set(142, 40);
      // A slot read takes 9 s of the 40 s a run may take.
      io.pageTxs.mockImplementation(async (start: Date, _end: Date, onPage: (rows: TxRow[]) => Promise<void>) => {
        const slot = slotOf(start);
        slotsRead.push(slot);
        clock += 9_000;
        await onPage(Array.from({ length: missing.get(slot) ?? 0 }, (_, i) => tx(slot * 1000 + i, slot)));
      });
      await svc.tick();
      clock += 30 * MIN;

      expect(await svc.tick()).toBe(0);
      expect(slotsRead).toEqual([1, 2, 3, 4, 5]);
      expect(table.get(DAY)).toMatchObject({ status: 'repairing' });
      // Read, with nothing more to settle while the day holds fewer rows than the provider counts.
      expect(table.get(DAY)?.progress?.slice(0, 7)).toBe('0iiiii0');

      await svc.tick();
      expect(slotsRead.slice(5)).toEqual([6, 7, 8, 9, 10]);
    });

    it('ends as unrepaired after a whole re-read that changes nothing, reads it whole once more when the provider says otherwise, then never again', async () => {
      missing.clear(); // the provider counts 14 more than it lists
      await svc.tick();
      clock += 30 * MIN;
      await svc.tick();
      expect(slotsRead).toHaveLength(144);
      expect(table.get(DAY)).toMatchObject({ status: 'unrepaired', rereads: 1 });
      expect(rejects.take().map((r) => r.count)).toEqual([2]);

      // The same figures on the next scheduled read: it stays as it is.
      clock += 6 * 60 * MIN;
      await svc.tick();
      expect(slotsRead).toHaveLength(144);

      // The provider revises the day (still not ours): one more whole re-read, the last.
      theirs = { ...theirs, txs: theirs.txs + 1 };
      clock += 6 * 60 * MIN;
      await svc.tick();
      clock += 30 * MIN;
      await svc.tick();
      expect(table.get(DAY)).toMatchObject({ status: 'unrepaired', rereads: 2 });
      theirs = { ...theirs, txs: theirs.txs + 1 };
      clock += 6 * 60 * MIN;
      await svc.tick();
      clock += 30 * MIN;
      await svc.tick();
      expect(table.get(DAY)).toMatchObject({ status: 'unrepaired', rereads: 2 });
      expect(slotsRead).toHaveLength(288);
    });
  });

  describe('a day with more rows than the provider counts', () => {
    const gone = `0x${'d'.repeat(64)}`;
    const stays = `0x${'e'.repeat(64)}`;
    /** The rows we hold in slot 30 that the provider's list of it does not have. */
    let unlisted: string[];
    /** What the provider lists for slot 30. */
    let listedInSlot: number;
    beforeEach(() => {
      only();
      // One row more than the provider counts, in slot 30, the emptiest one (so it is read first).
      slots[30] = 3;
      theirs = { ...ours(), txs: ours().txs - 1 };
      unlisted = [gone, stays];
      listedInSlot = 2;
      (repo.txHashesBetween as jest.Mock).mockImplementation(async (start: Date) => (slotOf(start) === 30 ? [...unlisted] : []));
      // The rows the provider lists are rows we hold already: nothing to insert.
      (io.insertTxs as jest.Mock).mockResolvedValue(0);
      io.pageTxs.mockImplementation(async (start: Date, _end: Date, onPage: (rows: TxRow[]) => Promise<void>) => {
        const slot = slotOf(start);
        slotsRead.push(slot);
        await onPage(slot === 30 ? Array.from({ length: listedInSlot }, (_, i) => tx(900 + i, 30)) : []);
      });
      io.txListed.mockImplementation(async (hash: string) => hash !== gone);
      (repo.removeTxs as jest.Mock).mockImplementation(async (hashes: string[]) => {
        slots[30] -= hashes.length;
        unlisted = unlisted.filter((h) => !hashes.includes(h));
        return hashes.length;
      });
    });
    /** The difference is seen, lasts 30 minutes, and the re-read starts. */
    const confirmed = async (): Promise<void> => {
      await svc.tick();
      clock += 30 * MIN;
      await svc.tick();
    };
    /** The runs of the next half hour, 5 minutes apart, while the re-read is under way. */
    const later = async (runs = 6): Promise<void> => {
      for (let i = 0; i < runs && table.get(DAY)?.status === 'repairing'; i++) {
        clock += 5 * MIN;
        await svc.tick();
      }
    };

    it('does not remove a row on the provider’s first "not found": it waits for a second one, 10 minutes later', async () => {
      await confirmed();
      expect(io.txListed.mock.calls.map((c) => c[0])).toEqual([gone, stays]);
      expect(repo.removeTxs).not.toHaveBeenCalled();
      expect(table.get(DAY)?.status).toBe('repairing');

      // Too soon: the slot is not read again, whatever else was.
      clock += 5 * MIN;
      const before = slotsRead.filter((s) => s === 30).length;
      await svc.tick();
      expect(slotsRead.filter((s) => s === 30).length).toBe(before);
      expect(repo.removeTxs).not.toHaveBeenCalled();
    });

    it('removes it after the second "not found", from a fresh read of the slot, and only the row the provider says is gone', async () => {
      await confirmed();
      await later();
      expect(slotsRead.filter((s) => s === 30).length).toBe(2);
      expect(repo.removeTxs).toHaveBeenCalledTimes(1);
      // With the ten minutes of the slot the row was found in: the removal stays inside its days.
      const span = (repo.removeTxs as jest.Mock).mock.calls[0][1] as { start: Date; end: Date };
      expect(repo.removeTxs).toHaveBeenCalledWith([gone], span);
      expect(span.end.getTime() - span.start.getTime()).toBe(600_000);
      expect(span.start.toISOString().slice(0, 10)).toBe(DAY);
      expect(table.get(DAY)).toMatchObject({ status: 'ok', rowsRemoved: 1 });
      expect(rejects.take()).toEqual(expect.arrayContaining([expect.objectContaining({ stream: 'check', reason: 'reorg', count: 1 })]));
    });

    it('keeps a row the provider finds again at the second look', async () => {
      await confirmed();
      io.txListed.mockResolvedValue(true);
      await later();
      expect(repo.removeTxs).not.toHaveBeenCalled();
      expect(table.get(DAY)?.status).toBe('unrepaired');
    });

    it('never removes more rows than the day holds in excess, however many the provider says are gone', async () => {
      // Three rows the provider does not find, for an excess of one.
      unlisted = [gone, stays, `0x${'c'.repeat(64)}`];
      io.txListed.mockResolvedValue(false);
      await confirmed();
      await later();
      expect(repo.removeTxs).toHaveBeenCalledTimes(1);
      expect((repo.removeTxs as jest.Mock).mock.calls[0][0]).toHaveLength(1);
      expect(table.get(DAY)).toMatchObject({ status: 'ok', rowsRemoved: 1 });
    });

    it('removes nothing from a slot the provider lists nothing for: a provider with a hole looks just like that', async () => {
      listedInSlot = 0;
      io.txListed.mockResolvedValue(false);
      await confirmed();
      await later();
      expect(io.txListed).not.toHaveBeenCalled();
      expect(repo.removeTxs).not.toHaveBeenCalled();
      expect(table.get(DAY)?.status).toBe('unrepaired');
      // Counted three times: the difference, the slot left as it is, the day still different at the end.
      expect(rejects.take()).toEqual([expect.objectContaining({ stream: 'check', reason: 'day-gap', count: 3 })]);
    });

    it('removes nothing from a slot with more than 50 rows the provider does not list: that is not a reorganisation', async () => {
      unlisted = Array.from({ length: 51 }, (_, i) => `0x${i.toString(16).padStart(64, 'f')}`);
      await confirmed();
      await later();
      expect(io.txListed).not.toHaveBeenCalled();
      expect(repo.removeTxs).not.toHaveBeenCalled();
      expect(table.get(DAY)?.status).toBe('unrepaired');
    });

    it('removes nothing at all with ELYSIUM_DAY_CHECK_REMOVE=false, and still reads the day', async () => {
      process.env.ELYSIUM_DAY_CHECK_REMOVE = 'false';
      try {
        await confirmed();
        await later(3);
        expect(repo.txHashesBetween).not.toHaveBeenCalled();
        expect(io.txListed).not.toHaveBeenCalled();
        expect(slotsRead).toHaveLength(144);
        expect(table.get(DAY)?.status).toBe('unrepaired');
      } finally {
        delete process.env.ELYSIUM_DAY_CHECK_REMOVE;
      }
    });

    it('does not look for such rows in a day that has fewer rows than the provider counts', async () => {
      theirs = { ...ours(), txs: ours().txs + 10 };
      (io.insertTxs as jest.Mock).mockImplementation(async (rows: TxRow[]) => {
        slots[30] += rows.length;
        return rows.length;
      });
      io.pageTxs.mockImplementation(async (start: Date, _end: Date, onPage: (rows: TxRow[]) => Promise<void>) => {
        const slot = slotOf(start);
        slotsRead.push(slot);
        await onPage(slot === 30 ? Array.from({ length: 10 }, (_, i) => tx(30_000 + i, 30)) : []);
      });
      await confirmed();
      expect(repo.txHashesBetween).not.toHaveBeenCalled();
      expect(table.get(DAY)?.status).toBe('ok');
    });

    it('comes back to a slot read before the day’s holes were filled, once the day does hold too many rows', async () => {
      // Slot 30 holds a row the chain dropped beside one that is fine; slot 80 lacks two rows. The
      // emptiest (30) is read first, while the day still holds fewer rows than the provider counts.
      slots[30] = 2;
      slots[80] = 5;
      theirs = { ...ours(), txs: ours().txs + 1 }; // two to add, one to remove
      unlisted = [gone];
      (io.insertTxs as jest.Mock).mockImplementation(async (rows: TxRow[]) => {
        const fresh = rows.filter((r) => slotOf(new Date(Date.parse(r.block_time) - 1000)) === 80);
        slots[80] += fresh.length;
        return fresh.length;
      });
      let slot80Read = false;
      io.pageTxs.mockImplementation(async (start: Date, _end: Date, onPage: (rows: TxRow[]) => Promise<void>) => {
        const slot = slotOf(start);
        slotsRead.push(slot);
        if (slot === 80 && !slot80Read) {
          slot80Read = true;
          await onPage([tx(80_001, 80), tx(80_002, 80)]);
        } else await onPage(slot === 30 ? [tx(30_001, 30)] : []);
      });

      await confirmed();
      await later(8);

      expect(slotsRead[0]).toBe(30);
      expect(slotsRead.filter((s) => s === 30).length).toBeGreaterThanOrEqual(2);
      expect(repo.removeTxs).toHaveBeenCalledWith([gone], expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }));
      expect(table.get(DAY)).toMatchObject({ status: 'ok', rowsAdded: 2, rowsRemoved: 1 });
    });
  });

  describe('a slot that fails', () => {
    beforeEach(() => {
      only();
      slots[80] = 0;
      missing.set(80, 7);
    });

    it('a failure of the provider fails the run, and the slot is read again later: it is never given up for that', async () => {
      const outage = Object.assign(new Error('API error: 503'), { name: 'HttpApiError' });
      io.pageTxs.mockRejectedValue(outage);
      await svc.tick();
      clock += 30 * MIN;
      for (let i = 0; i < 6; i++) {
        await expect(svc.tick()).rejects.toThrow('API error: 503');
        clock += 5 * MIN;
      }
      expect(table.get(DAY)?.progress?.includes('x')).toBe(false);
      expect(table.get(DAY)?.status).toBe('repairing');
    });

    it('a slot whose own statements fail three times is given up, so the day’s re-read can end and the next day gets its turn', async () => {
      // The rows of that slot cannot be stored (a statement of ours that times out); the empty slots are fine.
      (io.insertTxs as jest.Mock).mockImplementation(async (rows: TxRow[]) => {
        if (rows.length > 0) throw new Error('canceling statement due to statement timeout');
        return 0;
      });
      await svc.tick();
      clock += 30 * MIN;
      for (let i = 0; i < 3; i++) {
        await expect(svc.tick()).rejects.toThrow('statement timeout');
        clock += 5 * MIN;
      }
      expect(table.get(DAY)?.progress?.[80]).toBe('x');

      // The rest of the day is read; the day ends as unrepaired instead of holding the check for good.
      for (let i = 0; i < 4 && table.get(DAY)?.status === 'repairing'; i++) {
        await svc.tick();
        clock += 5 * MIN;
      }
      expect(table.get(DAY)?.status).toBe('unrepaired');
      expect(slotsRead.filter((s) => s === 80).length).toBe(3);
    });
  });

  describe('the provider’s figures', () => {
    beforeEach(only);

    it('a day it revises while it is being read again keeps what was read', async () => {
      slots.fill(0);
      theirs = { ...theirs, txs: 40 };
      missing.clear();
      missing.set(142, 40);
      io.pageTxs.mockImplementation(async (start: Date, _end: Date, onPage: (rows: TxRow[]) => Promise<void>) => {
        const slot = slotOf(start);
        slotsRead.push(slot);
        clock += 9_000;
        await onPage(Array.from({ length: missing.get(slot) ?? 0 }, (_, i) => tx(slot * 1000 + i, slot)));
      });
      await svc.tick();
      clock += 30 * MIN;
      await svc.tick();
      const done = table.get(DAY)?.progress;

      // Its count of the day moves by one before the next run.
      theirs = { ...theirs, txs: 41 };
      clock += 5 * MIN;
      await svc.tick();

      expect(table.get(DAY)?.status).toBe('repairing');
      expect(table.get(DAY)?.provider.txs).toBe(41);
      // The slots read stay read: the run went on after them.
      expect(table.get(DAY)?.progress?.slice(0, 6)).toBe(done?.slice(0, 6));
      expect(slotsRead.slice(5, 7)).toEqual([6, 7]);
    });

    it('a day it does not list is not asked for every 5 minutes', async () => {
      io.fetchDaily.mockResolvedValue([]);
      await svc.tick();
      expect(io.fetchDaily).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 6; i++) {
        clock += 5 * MIN;
        expect(await svc.tick()).toBe(30 * MIN);
      }
      expect(io.fetchDaily).toHaveBeenCalledTimes(1);
      // It is asked for again on the 6-hour schedule.
      clock += 6 * 60 * MIN;
      await svc.tick();
      expect(io.fetchDaily).toHaveBeenCalledTimes(2);
    });
  });

  it('reads at most two whole days again per UTC day, whatever differs', async () => {
    // Four days differ, and no re-read helps.
    for (const d of ['2026-11-04', '2026-11-05', '2026-11-06']) table.set(d, row({ day: d }));
    theirs = { ...theirs, txs: theirs.txs + 100 };
    io.fetchDaily.mockImplementation(async () => ['2026-11-07', '2026-11-08', '2026-11-09', DAY].map((day) => ({ day, ...theirs })));
    await svc.tick();
    clock += 30 * MIN;
    for (let i = 0; i < 12; i++) {
      await svc.tick();
      clock += 5 * MIN;
    }
    expect(slotsRead).toHaveLength(288);

    // The next UTC day: the allowance is whole again.
    clock = Date.parse('2026-11-12T00:30:00Z');
    io.head.mockResolvedValue(new Date(clock - 5_000));
    io.txCursor.mockResolvedValue(new Date(clock - 15_000));
    await svc.tick();
    expect(slotsRead.length).toBeGreaterThan(288);
  });
});

describe('what is not a slot\'s own failure', () => {
  const named = (name: string, message = 'x'): Error => Object.assign(new Error(message), { name });

  it('a request the provider did not answer in time: the HTTP clients say it as a plain "Request timeout"', () => {
    expect(isProviderFailure(new Error('Request timeout'))).toBe(true);
    expect(isProviderFailure(new Error('API request failed: fetch failed'))).toBe(true);
    expect(isProviderFailure(named('HttpApiError', 'API error: 503'))).toBe(true);
  });

  it('a run ended on purpose: the service stopping, the tick given up at its time limit', () => {
    expect(isProviderFailure(named('IngestStoppedError'))).toBe(true);
    expect(isProviderFailure(named('TickGivenUpError'))).toBe(true);
  });

  it('a statement of ours that fails is the slot\'s failure', () => {
    expect(isProviderFailure(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(isProviderFailure(named('PrismaClientKnownRequestError', 'Raw query failed'))).toBe(false);
    expect(isProviderFailure('not an error')).toBe(false);
  });
});
