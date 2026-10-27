/**
 * A failed historical write used to drop its whole batch (up to 100 rows) for good.
 * It is now kept for a bounded retry; inserts skip duplicates so a retry is safe.
 */
const mockRepo = {
  createMany: jest.fn(),
  upsertIngestionState: jest.fn(async () => undefined),
};
let rawListener: ((liqs: unknown[]) => void) | null = null;

jest.mock('../../../src/repositories', () => ({ historicalLiquidationRepository: mockRepo }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/liquidations/liquidations.ws.service', () => ({
  LiquidationsWebSocketService: {
    getInstance: () => ({
      onRawLiquidation: (cb: (liqs: unknown[]) => void) => {
        rawListener = cb;
        return () => { rawListener = null; };
      },
    }),
  },
}));

import { LiquidationsIngestionService } from '../../../src/services/liquidations/liquidations.ingestion.service';

const row = (tid: number) => ({
  tid, time_ms: 1_700_000_000_000 + tid, coin: 'BTC', hash: `0x${tid}`, liquidated_user: '0xabc',
  notional_total: 10, mark_px: 5, size_total: 1, fee_total_liquidated: 0, liquidators: [], liquidator_count: 0, method: 'm', liq_dir: 'Long',
});

describe('LiquidationsIngestionService failed batches', () => {
  const svc = LiquidationsIngestionService.getInstance();
  const flush = () => (svc as unknown as { flushBatch(): Promise<void> }).flushBatch();
  const pending = () => svc.getStats().pendingBatchSize;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    mockRepo.createMany.mockReset();
    svc.start();
  });
  afterEach(async () => {
    mockRepo.createMany.mockResolvedValue({ count: 0 });
    await svc.stop();
    jest.useRealTimers();
  });

  it('keeps the rows of a failed batch and writes them on the retry', async () => {
    mockRepo.createMany.mockRejectedValueOnce(new Error('Connection terminated'));
    mockRepo.createMany.mockImplementation(async (d: unknown[]) => ({ count: d.length }));
    rawListener!([row(1), row(2)]);
    await flush();
    expect(pending()).toBe(2);

    await flush(); // still backing off: no write
    expect(mockRepo.createMany).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2_500);
    await flush();
    expect(mockRepo.createMany).toHaveBeenCalledTimes(2);
    expect(mockRepo.createMany.mock.calls[1][0]).toHaveLength(2);
    expect(pending()).toBe(0);
  });

  it('never buffers more than its cap while the DB is down', async () => {
    mockRepo.createMany.mockRejectedValue(new Error('down'));
    rawListener!([row(1)]);
    await flush();
    for (let i = 0; i < 30; i++) rawListener!(Array.from({ length: 100 }, (_, j) => row(1000 + i * 100 + j)));
    expect(pending()).toBeLessThanOrEqual(1000);
  });

  it('drops a batch the DB keeps rejecting after bounded attempts', async () => {
    mockRepo.createMany.mockRejectedValue(new Error('invalid byte sequence'));
    rawListener!([row(1)]);
    for (let i = 0; i < 12; i++) {
      await flush();
      jest.advanceTimersByTime(11_000);
    }
    expect(pending()).toBe(0);
    expect(mockRepo.createMany.mock.calls.length).toBe(10);
  });

  it('skips a row whose tid is not an integer instead of poisoning its batch', async () => {
    mockRepo.createMany.mockImplementation(async (d: unknown[]) => ({ count: d.length }));
    rawListener!([row(1.5), row(2)]);
    await flush();
    expect(mockRepo.createMany.mock.calls[0][0]).toHaveLength(1);
  });
});
