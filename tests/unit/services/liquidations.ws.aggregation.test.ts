/**
 * flushAggregation runs from a bare setTimeout: a row the aggregator cannot read
 * (no `liquidators` list) used to throw out of the timer (uncaughtException, process
 * restart) and stayed in the buffer, so the next flush threw again.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/core/redis.service', () => ({ redisService: { set: jest.fn(async () => undefined) } }));
jest.mock('../../../src/clients/hypedexer/websocket/liquidations.ws.client', () => ({
  HypeDexerLiquidationsWSClient: { getInstance: () => ({ onLiquidation: jest.fn(), start: jest.fn(), stop: jest.fn() }) },
}));

import { LiquidationsWebSocketService } from '../../../src/services/liquidations/liquidations.ws.service';
import { logDeduplicator } from '../../../src/utils/logDeduplicator';

const row = (tid: number, user: string, extra: Record<string, unknown> = {}) => ({
  tid, time: new Date().toISOString(), time_ms: Date.now(), coin: 'BTC', hash: `0x${tid}`, liquidated_user: user,
  size_total: 1, notional_total: 10, fill_px_vwap: 5, mark_px: 5, method: 'm', fee_total_liquidated: 0,
  liquidators: ['0xl'], liquidator_count: 1, liq_dir: 'Long', ...extra,
});

describe('LiquidationsWebSocketService aggregation flush', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('skips a malformed group and still aggregates the others, without throwing from the timer', () => {
    const svc = LiquidationsWebSocketService.getInstance();
    const out: unknown[][] = [];
    const off = svc.onProcessedLiquidation((l) => { out.push(l); });
    const handle = (svc as unknown as { handleIncomingLiquidations(l: unknown[]): void }).handleIncomingLiquidations.bind(svc);

    handle([row(1, '0xa', { liquidators: null }), row(2, '0xb')]);
    expect(() => jest.advanceTimersByTime(2_000)).not.toThrow();

    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1);
    expect((out[0][0] as { liquidated_user: string }).liquidated_user).toBe('0xb');
    expect(logDeduplicator.error).toHaveBeenCalledWith(
      expect.stringContaining('Malformed liquidation skipped'),
      expect.anything(),
    );

    // the bad row is gone: the next window is clean
    handle([row(3, '0xc')]);
    jest.advanceTimersByTime(2_000);
    expect(out).toHaveLength(2);
    off();
  });
});
