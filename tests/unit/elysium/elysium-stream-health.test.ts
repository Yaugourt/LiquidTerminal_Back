/**
 * How a stream is doing, as the status route says it (2026-11-11). The lag shown was
 * `now - cursor` for every stream: near zero for the ones whose cursor is the time of their run
 * even when the provider returned nothing, and ten hours for the RPC fallback while it was
 * simply at rest. Each stream now has a state computed from what it is expected to do.
 */
import { streamHealth } from '../../../src/services/elysium/elysium-analytics.util';

const NOW = Date.parse('2026-11-11T18:00:00Z');
const ago = (s: number): Date => new Date(NOW - s * 1000);
const row = (stream: string, over: Partial<{ cursor: Date | null; lastError: string | null; okAt: Date | null; backfillDone: boolean }> = {}) => ({
  stream,
  cursor: ago(20),
  lastError: null,
  okAt: ago(20),
  ...over,
});
const current = ago(8);

describe('streamHealth', () => {
  it('a stream that runs and whose data is current is ok, with its lag', () => {
    expect(streamHealth(row('tx'), NOW, current)).toEqual({ lagSeconds: 20, everyS: 30, state: 'ok' });
  });

  it('a stream still reading the history for the first time is backfilling, not behind; it is failing or stalled like any other', () => {
    const month = ago(30 * 86_400);
    expect(streamHealth(row('tx', { cursor: month, backfillDone: false }), NOW, current).state).toBe('backfilling');
    expect(streamHealth(row('dex', { cursor: month, backfillDone: false }), NOW, ago(6 * 3600)).state).toBe('backfilling');
    expect(streamHealth(row('tx', { cursor: month, backfillDone: false, lastError: 'API error: 500' }), NOW, current).state).toBe('failing');
    expect(streamHealth(row('tx', { cursor: month, backfillDone: false, okAt: ago(3600) }), NOW, current).state).toBe('stalled');
    // Its history read, the same lag is a lag.
    expect(streamHealth(row('tx', { cursor: month, backfillDone: true }), NOW, current).state).toBe('behind');
    expect(streamHealth(row('tx', { cursor: ago(20), backfillDone: false }), NOW, current).state).toBe('ok');
  });

  it('a stream whose last run failed is failing, whatever its cursor', () => {
    expect(streamHealth(row('dex', { lastError: 'API error: 503' }), NOW, current).state).toBe('failing');
  });

  it('a stream with no completed run for three of its periods, and 5 minutes, is stalled', () => {
    expect(streamHealth(row('tx', { okAt: ago(4 * 60) }), NOW, current).state).toBe('ok');
    expect(streamHealth(row('tx', { okAt: ago(6 * 60) }), NOW, current).state).toBe('stalled');
    // A registry run every 15 minutes: stalled after 45.
    expect(streamHealth(row('tokens', { okAt: ago(40 * 60) }), NOW, current).state).toBe('ok');
    expect(streamHealth(row('tokens', { okAt: ago(50 * 60) }), NOW, current).state).toBe('stalled');
    expect(streamHealth(row('tx', { okAt: null }), NOW, current).state).toBe('stalled');
  });

  it('tells a tx stream that waits at the provider\'s head from one that is behind on its own', () => {
    const sixHours = 6 * 3600;
    // The provider stopped six hours ago; the stream ticks, with nothing to read.
    expect(streamHealth(row('tx', { cursor: ago(sixHours + 3) }), NOW, ago(sixHours))).toEqual({
      lagSeconds: sixHours + 3,
      everyS: 30,
      state: 'waiting-provider',
    });
    // The provider is current and the stream is twenty minutes behind it.
    expect(streamHealth(row('tx', { cursor: ago(20 * 60) }), NOW, current).state).toBe('behind');
  });

  it('gives the log streams no such excuse: they read past the provider\'s head from the RPC', () => {
    expect(streamHealth(row('dex', { cursor: ago(3600) }), NOW, ago(6 * 3600)).state).toBe('behind');
    expect(streamHealth(row('launchpad', { cursor: ago(3600) }), NOW, ago(6 * 3600)).state).toBe('behind');
  });

  it('the bridge\'s lag is the age of its newest transfer, and is no fault: nobody may have bridged for hours', () => {
    // A quiet bridge on a provider that is current: it runs, it is ok (it was "behind" after 5 minutes without a transfer).
    expect(streamHealth(row('bridge', { cursor: ago(6 * 3600) }), NOW, current)).toEqual({ lagSeconds: 6 * 3600, everyS: 60, state: 'ok' });
    expect(streamHealth(row('bridge', { cursor: ago(200) }), NOW, current).state).toBe('ok');
    // It reads nothing but the provider: when that stands still, it waits for it.
    expect(streamHealth(row('bridge', { cursor: ago(6 * 3600) }), NOW, ago(6 * 3600)).state).toBe('waiting-provider');
    // It is failing or stalled like any other.
    expect(streamHealth(row('bridge', { lastError: 'API error: 500' }), NOW, current).state).toBe('failing');
    expect(streamHealth(row('bridge', { okAt: ago(600) }), NOW, current).state).toBe('stalled');
  });

  it('a row of a stream this version does not know is shown with its error, and not judged by a cadence it does not have', () => {
    expect(streamHealth(row('a-stream-of-another-version', { okAt: ago(86_400) }), NOW, current)).toEqual({ lagSeconds: null, everyS: null, state: 'ok' });
    expect(streamHealth(row('a-stream-of-another-version', { lastError: 'boom' }), NOW, current).state).toBe('failing');
  });

  it('shows no lag for a stream whose cursor is the time of its run, and judges it by its runs', () => {
    expect(streamHealth(row('tokens', { cursor: ago(700), okAt: ago(700) }), NOW, current)).toEqual({ lagSeconds: null, everyS: 900, state: 'ok' });
    expect(streamHealth(row('launchstats'), NOW, current).lagSeconds).toBeNull();
  });

  it('the RPC fallback is at rest while the provider is current: ok, with no lag, whatever its cursor says', () => {
    expect(streamHealth(row('txlive', { cursor: ago(37_181) }), NOW, current)).toEqual({ lagSeconds: null, everyS: 60, state: 'ok' });
  });

  it('judges a stream it does not know by its runs alone', () => {
    expect(streamHealth(row('someday'), NOW, current)).toEqual({ lagSeconds: null, everyS: null, state: 'ok' });
  });

  it('calls a late tx stream behind when the provider\'s head is not known: nothing says it is waiting', () => {
    expect(streamHealth(row('tx', { cursor: ago(3600) }), NOW, null).state).toBe('behind');
  });
});
