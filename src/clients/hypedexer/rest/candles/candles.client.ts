import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { cacheService } from '../../../../core/cache.service';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

export const CANDLE_INTERVALS = ['5s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export interface Candle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

/** Seconds per interval, for cache bucketing. */
const STEP_S: Record<CandleInterval, number> = { '5s': 5, '30s': 30, '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

/**
 * HypeDexer candles: Hyperliquid-format `candleSnapshot` on the indexer's
 * unified /info endpoint, built from taker fills, down to 5-second bars
 * (Hyperliquid's own API stops at 1 minute).
 */
export class HypeDexerCandlesClient extends HypeDexerBaseClient {
  private static instance: HypeDexerCandlesClient;
  private readonly circuitBreaker = CircuitBreakerService.getInstance('hypedexer-candles');

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
  }

  public static getInstance(): HypeDexerCandlesClient {
    if (!HypeDexerCandlesClient.instance) HypeDexerCandlesClient.instance = new HypeDexerCandlesClient();
    return HypeDexerCandlesClient.instance;
  }

  /**
   * Cached per (coin, interval, start/end rounded to one bar): every viewer of
   * a chart asks for "the last N bars", which lands on the same key within a
   * bar. TTL = one bar, at least 2s and at most 60 s: the route is public, so
   * a 1d key held a day would let anyone park day-long entries (the front
   * only reads 5s and 30s bars here). No last copy: the key moves on with the
   * next bar, so a copy (~150 KB for 1 000 bars) would never be read.
   */
  public getCandles(coin: string, interval: CandleInterval, startTime: number, endTime: number): Promise<Candle[]> {
    const step = STEP_S[interval] * 1000;
    const key = `hypedexer:candles:${coin}:${interval}:${Math.floor(startTime / step)}:${Math.floor(endTime / step)}`;
    return cacheService.getOrSet(
      key,
      () =>
        this.circuitBreaker.execute(() =>
          this.post<Candle[]>('/info', { type: 'candleSnapshot', req: { coin, interval, startTime, endTime } })
        ),
      Math.min(60, Math.max(2, STEP_S[interval])),
      { lastCopy: false }
    );
  }
}
