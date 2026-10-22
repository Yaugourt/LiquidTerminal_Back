import { z } from 'zod';

/**
 * Shared bounds for the /indexer passthrough query params. Every distinct
 * value of a param the caller picks is its own cache key, and every miss is a
 * paid HypeDexer call, so free-form strings and unbounded numbers let one
 * known address fan out into endless billed pages. Reject them with a 400
 * instead of lowering the limits normal browsing hits.
 */

/** Deepest `offset` accepted (the upstream deprecated it in favour of cursors). */
export const MAX_INDEXER_OFFSET = 10000;

export const indexerOffset = z.coerce.number().int().min(0).max(MAX_INDEXER_OFFSET).optional();

// ISO 8601 date-time (the front sends `2023-01-01T00:00:00` and `...Z`, with
// or without milliseconds / an offset) or epoch seconds / milliseconds.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const EPOCH = /^\d{10,13}$/;

/**
 * A time bound: ISO 8601 date-time or epoch (s / ms), at most 40 chars. An
 * empty string stays accepted (it means "not set", as before).
 */
export const indexerTime = z
  .string()
  .max(40)
  .refine(
    (v) => v === '' || EPOCH.test(v) || (ISO_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v))),
    { message: 'Invalid time: expected ISO 8601 date-time or epoch' }
  )
  .optional();

/** Keyset cursor `<time_ms>:<tid>` as the upstream hands it out. */
export const indexerCursor = z
  .string()
  .max(96)
  .regex(/^(\d{1,16}:[0-9A-Za-z_-]{1,64})?$/, 'Invalid cursor')
  .optional();

/** Upstream `time_range` presets. */
export const indexerTimeRange = z.enum(['1h', '24h', '7d', '30d']).optional();

/** A finite number within ±`max` (notional / PnL filters). */
export const indexerBoundedNumber = (max: number) =>
  z.coerce.number().min(-max).max(max).optional();

/** Look-back window in hours: up to a year. */
export const indexerHours = z.coerce.number().min(0).max(8760).optional();
