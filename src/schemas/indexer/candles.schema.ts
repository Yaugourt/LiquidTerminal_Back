import { z } from 'zod';
import { CANDLE_INTERVALS } from '../../clients/hypedexer/rest/candles/candles.client';

/**
 * Every distinct coin is a distinct cache key and a paid upstream read, so the
 * coin is held to the shapes the app sends: a spot pair (`@107`, `PURR/USDC`),
 * a perp (`BTC`, `kPEPE`) or a HIP-3 market (`xyz:AAPL`).
 */
export const CANDLE_COIN_PATTERN = /^(?:@\d{1,5}|[A-Za-z0-9]{1,12}\/USDC|[A-Za-z0-9][A-Za-z0-9._-]{0,19}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,31})?)$/;

/** Hyperliquid mainnet launched in 2023: no candle is older, none is in the future. */
const MIN_TIME_MS = Date.UTC(2023, 0, 1);
/**
 * Oldest endTime served. The chart asks for a window ending when the page
 * opened, so a tab left open for hours still sends a recent end; an end days
 * in the past is only a way to mint fresh (start, end) cache keys.
 */
export const MAX_END_AGE_MS = 24 * 60 * 60 * 1000;

/** GET /indexer/candles?coin=BTC&interval=5s&startTime=…&endTime=… */
export const candlesQuerySchema = z.object({
  query: z.object({
    coin: z.string().regex(CANDLE_COIN_PATTERN, 'Invalid coin'),
    interval: z.enum(CANDLE_INTERVALS),
    startTime: z.coerce.number().int().min(MIN_TIME_MS),
    endTime: z.coerce.number().int().min(MIN_TIME_MS).optional(),
  }),
  params: z.object({}),
}).refine(
  ({ query }) => query.endTime === undefined || query.endTime >= Date.now() - MAX_END_AGE_MS,
  { message: 'endTime is too old', path: ['query', 'endTime'] }
).refine(
  // An inverted window went upstream as is: one more axis of fresh keys.
  ({ query }) => query.startTime <= (query.endTime ?? Date.now()),
  { message: 'startTime is after endTime', path: ['query', 'startTime'] }
);
