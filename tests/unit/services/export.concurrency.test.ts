import {
  acquireExportSlot,
  releaseExportSlot,
  exportConcurrencySnapshot,
  ExportBusyError,
} from '../../../src/services/export/export.concurrency';
import {
  EXPORT_MAX_CONCURRENT,
  EXPORT_QUEUE_MAX_DEPTH,
} from '../../../src/constants/export.constants';

/** Drains the semaphore so each test starts from a known state. */
function drain(): void {
  for (let i = 0; i < EXPORT_MAX_CONCURRENT + EXPORT_QUEUE_MAX_DEPTH + 5; i++) {
    releaseExportSlot();
  }
}

describe('export concurrency gate', () => {
  beforeEach(drain);
  afterEach(drain);

  it('lets exactly the capacity through without waiting', async () => {
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i++) {
      await acquireExportSlot();
    }
    expect(exportConcurrencySnapshot().active).toBe(EXPORT_MAX_CONCURRENT);
  });

  it('queues the next caller instead of admitting it', async () => {
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i++) await acquireExportSlot();

    let admitted = false;
    const queued = acquireExportSlot().then(() => {
      admitted = true;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(exportConcurrencySnapshot().queued).toBe(1);

    releaseExportSlot();
    await queued;
    expect(admitted).toBe(true);
  });

  it('hands a freed slot to the caller that waited longest', async () => {
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i++) await acquireExportSlot();

    const order: number[] = [];
    const first = acquireExportSlot().then(() => order.push(1));
    const second = acquireExportSlot().then(() => order.push(2));

    releaseExportSlot();
    await first;
    releaseExportSlot();
    await second;

    expect(order).toEqual([1, 2]);
  });

  it('refuses immediately once the queue is full', async () => {
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i++) await acquireExportSlot();

    const queued = Array.from({ length: EXPORT_QUEUE_MAX_DEPTH }, () =>
      acquireExportSlot().catch(() => undefined)
    );
    await Promise.resolve();

    // A queue that grows without bound is just held-open connections.
    await expect(acquireExportSlot()).rejects.toBeInstanceOf(ExportBusyError);

    for (let i = 0; i < EXPORT_QUEUE_MAX_DEPTH + EXPORT_MAX_CONCURRENT; i++) releaseExportSlot();
    await Promise.all(queued);
  });

  it('carries a retry hint the client can act on', async () => {
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i++) await acquireExportSlot();
    const queued = Array.from({ length: EXPORT_QUEUE_MAX_DEPTH }, () =>
      acquireExportSlot().catch(() => undefined)
    );
    await Promise.resolve();

    await acquireExportSlot().then(
      () => {
        throw new Error('should have been refused');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(ExportBusyError);
        expect((error as ExportBusyError).retryAfterSeconds).toBeGreaterThan(0);
      }
    );

    for (let i = 0; i < EXPORT_QUEUE_MAX_DEPTH + EXPORT_MAX_CONCURRENT; i++) releaseExportSlot();
    await Promise.all(queued);
  });

  it('never lets the active count go negative on an extra release', () => {
    releaseExportSlot();
    releaseExportSlot();
    expect(exportConcurrencySnapshot().active).toBe(0);
  });
});
