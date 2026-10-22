/**
 * /indexer passthrough schemas: parameters the caller picks end up in cache
 * keys and billed upstream calls, so they are bounded. Every value the front
 * actually sends must stay valid.
 */
import {
  indexerFillsQuerySchema,
  indexerFillsSpotQuerySchema,
  indexerFillsSpotUserQuerySchema,
  indexerFillsUserAddressQuerySchema,
} from '../../../src/schemas/indexer/fills.schema';
import {
  indexerUsersCoinsQuerySchema,
  indexerUsersPerformanceQuerySchema,
} from '../../../src/schemas/indexer/users-indexer.schema';
import { indexerFundingUserFundingQuerySchema } from '../../../src/schemas/indexer/funding.schema';
import { twapsListQuerySchema, twapsUserQuerySchema } from '../../../src/schemas/indexer/twaps.schema';
import { indexerCompletedTradesListQuerySchema } from '../../../src/schemas/indexer/completed-trades.schema';

const ADDR = '0x' + 'ab'.repeat(20);
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, query: unknown, params: unknown = {}) =>
  schema.safeParse({ query, params }).success;

describe('indexer fills schemas', () => {
  it('accepts what the front sends', () => {
    // Dashboard live prints.
    expect(
      ok(indexerFillsQuerySchema, {
        coin: 'BTC',
        size_usd: '25000',
        start_time: '2026-10-22T10:00:00.000Z',
        limit: '1000',
        order: 'desc',
      })
    ).toBe(true);
    // Priority-fees tape, deep-ish page.
    expect(ok(indexerFillsQuerySchema, { limit: '12', offset: '120', has_priority_gas: 'true' })).toBe(true);
    expect(ok(indexerFillsQuerySchema, { start_time: '', cursor: '' })).toBe(true);
    expect(ok(indexerFillsUserAddressQuerySchema, { time_range: '24h', cursor: '1760000000000:123456789' }, { user_address: ADDR })).toBe(true);
    expect(ok(indexerFillsUserAddressQuerySchema, { start_time: '1760000000', end_time: '1760000000000' }, { user_address: ADDR })).toBe(true);
  });

  it('rejects unbounded offsets', () => {
    expect(ok(indexerFillsQuerySchema, { offset: '10000' })).toBe(true);
    expect(ok(indexerFillsQuerySchema, { offset: '10001' })).toBe(false);
    expect(ok(indexerFillsUserAddressQuerySchema, { offset: '99999999' }, { user_address: ADDR })).toBe(false);
    expect(ok(indexerFillsSpotQuerySchema, { offset: '1e9' })).toBe(false);
    expect(ok(indexerFillsSpotUserQuerySchema, { offset: '500000' }, { user_address: ADDR })).toBe(false);
  });

  it('rejects free-form cursors and times that only make cache keys', () => {
    expect(ok(indexerFillsQuerySchema, { cursor: 'x'.repeat(200) })).toBe(false);
    expect(ok(indexerFillsQuerySchema, { cursor: 'abc' })).toBe(false);
    expect(ok(indexerFillsUserAddressQuerySchema, { cursor: 'abc' }, { user_address: ADDR })).toBe(false);
    expect(ok(indexerFillsQuerySchema, { start_time: 'yesterday' })).toBe(false);
    expect(ok(indexerFillsQuerySchema, { end_time: '2026-13-45T00:00:00Z' })).toBe(false);
    expect(ok(indexerFillsSpotQuerySchema, { start_time: '12' })).toBe(false);
    expect(ok(indexerFillsUserAddressQuerySchema, { time_range: '999d' }, { user_address: ADDR })).toBe(false);
  });

  it('bounds numeric filters to finite ranges', () => {
    expect(ok(indexerFillsQuerySchema, { size_usd: 'Infinity' })).toBe(false);
    expect(ok(indexerFillsQuerySchema, { size_usd: 'abc' })).toBe(false);
    expect(ok(indexerFillsQuerySchema, { size_usd: '1e30' })).toBe(false);
    expect(ok(indexerFillsQuerySchema, { size_usd: '0.5' })).toBe(true);
  });
});

describe('other per-address indexer schemas', () => {
  it('users: the tracker sends its genesis start_time and limit 8', () => {
    expect(ok(indexerUsersPerformanceQuerySchema, { start_time: '2023-01-01T00:00:00' }, { user: ADDR })).toBe(true);
    expect(ok(indexerUsersCoinsQuerySchema, { limit: '8' }, { user: ADDR })).toBe(true);
    expect(ok(indexerUsersPerformanceQuerySchema, { start_time: 'a'.repeat(60) }, { user: ADDR })).toBe(false);
  });

  it('funding: ISO / epoch times only', () => {
    expect(ok(indexerFundingUserFundingQuerySchema, { user: ADDR, startTime: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(ok(indexerFundingUserFundingQuerySchema, { user: ADDR, startTime: 'nope' })).toBe(false);
  });

  it('twaps: the front polls hours=24 limit=150; offsets and windows are bounded', () => {
    expect(ok(twapsListQuerySchema, { limit: '150', hours: '24' })).toBe(true);
    expect(ok(twapsListQuerySchema, { hours: '1e9' })).toBe(false);
    expect(ok(twapsListQuerySchema, { hours: 'Infinity' })).toBe(false);
    expect(ok(twapsUserQuerySchema, { offset: '20000' }, { user_address: ADDR })).toBe(false);
    expect(ok(twapsUserQuerySchema, { offset: '40', limit: '50' }, { user_address: ADDR })).toBe(true);
  });

  it('completed trades: the explorer and tracker queries pass, unbounded filters do not', () => {
    expect(ok(indexerCompletedTradesListQuerySchema, { user: ADDR, limit: '50', sort_dir: 'DESC' })).toBe(true);
    expect(ok(indexerCompletedTradesListQuerySchema, { sort_by: 'pnl_realized', sort_dir: 'DESC', limit: '5', start_time: '2026-10-22T09:00:00.000Z' })).toBe(true);
    expect(ok(indexerCompletedTradesListQuerySchema, { min_pnl: '-250000.5', max_pnl: '1000000' })).toBe(true);
    expect(ok(indexerCompletedTradesListQuerySchema, { min_pnl: 'Infinity' })).toBe(false);
    expect(ok(indexerCompletedTradesListQuerySchema, { offset: '1000000' })).toBe(false);
    expect(ok(indexerCompletedTradesListQuerySchema, { start_time: 'last week' })).toBe(false);
  });
});
