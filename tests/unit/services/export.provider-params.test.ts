/**
 * The data provider ignores a query param it does not know, and refuses a limit above its own: a
 * wrong name gives a file that looks right and is not what was asked (the last 50,000 HIP-3 fills
 * for a window in the past), a wrong size gives no file at all.
 *
 * What each endpoint takes, read from the provider's OpenAPI document on 2026-11-25. `maxLimit` is
 * the cap it enforces (for /fills/ and /fills/spot/, the one its description gives: the 100 of the
 * schema is for its own web page); absent, it has none.
 */
import { EXPORT_DATASETS, type ExportDataset } from '../../../src/services/export/export.manifest';
import { sourceParams } from '../../../src/services/export/export.service';
import { EXPORT_PAGE_SIZE } from '../../../src/constants/export.constants';

const PROVIDER: Record<string, { params: string[]; maxLimit?: number }> = {
  '/builders/list': { params: [] },
  '/completed-trades/': { params: ['user', 'coin', 'direction', 'start_time', 'end_time', 'min_pnl', 'max_pnl', 'offset', 'limit', 'do_count', 'sort_by', 'sort_dir'] },
  '/evm/blocks': { params: ['start_block', 'end_block', 'start_time', 'end_time', 'limit', 'offset'], maxLimit: 1000 },
  '/evm/bridge/events': { params: ['user_addr', 'event_type', 'start_time', 'end_time', 'limit', 'offset'], maxLimit: 1000 },
  '/evm/ledger/transfers': { params: ['user', 'action_type', 'token', 'start_time', 'end_time', 'limit', 'offset'], maxLimit: 1000 },
  '/evm/transactions': { params: ['block_number', 'to_addr', 'start_time', 'end_time', 'include_system', 'limit', 'offset'], maxLimit: 1000 },
  '/fills/': { params: ['user', 'coin', 'side', 'size_usd', 'start_time', 'end_time', 'offset', 'limit', 'cursor', 'order', 'has_priority_gas', 'include_order_type'], maxLimit: 1000 },
  '/fills/spot/': { params: ['user', 'coin', 'coins', 'side', 'start_time', 'end_time', 'offset', 'limit', 'order', 'has_priority_gas'], maxLimit: 10000 },
  '/funding/fundingHistory': { params: ['coin', 'startTime', 'endTime', 'limit'], maxLimit: 5000 },
  '/hip3/assets': { params: ['dex_id', 'search', 'limit', 'offset'], maxLimit: 1000 },
  '/hip3/auctions/history': { params: ['dex_id', 'limit', 'offset'], maxLimit: 500 },
  '/hip3/dexs': { params: ['limit', 'offset'], maxLimit: 500 },
  '/hip3/fills': { params: ['dex_id', 'coin', 'user', 'side', 'start', 'end', 'min_notional', 'limit', 'offset'], maxLimit: 1000 },
  '/hip4/fills': { params: ['user', 'coin', 'outcome_id', 'start', 'end', 'limit', 'offset'], maxLimit: 1000 },
  '/hip4/markets': { params: ['outcome_id', 'class', 'underlying', 'question_id', 'status', 'limit', 'offset'], maxLimit: 1000 },
  '/hip4/settlements': { params: ['outcome_id', 'start', 'end', 'limit', 'offset'], maxLimit: 1000 },
  '/liquidations/': { params: ['coin', 'user', 'start_time', 'end_time', 'amount_dollars', 'limit', 'cursor', 'order'], maxLimit: 1000 },
  '/overview/top-traders-24h': { params: ['sort', 'limit'], maxLimit: 50 },
  '/spot/pairs': { params: ['limit', 'offset'] },
  '/spot/tokens': { params: ['search', 'limit', 'offset'] },
  '/twaps/': { params: ['user', 'coin', 'status', 'hours', 'limit', 'offset', 'order'], maxLimit: 500 },
  '/users/active': { params: ['hours', 'limit'], maxLimit: 100 },
  '/users/leaderboard': { params: ['by', 'hours', 'limit', 'window', 'page', 'min_trades'], maxLimit: 500 },
  '/vaults/vaultSummaries': { params: ['includeClosed', 'limit'], maxLimit: 5000 },
};

const ENUMS: Record<string, string[]> = {
  '/users/leaderboard window': ['7d', '30d', 'all'],
  '/users/leaderboard by': ['volume', 'pnl', 'trades', 'priority_fees', 'win_rate', 'pnl_pct', 'unrealized_pnl'],
};

const datasets = EXPORT_DATASETS.filter((d) => d.source !== 'local');
const byId = (id: string): ExportDataset => {
  const dataset = EXPORT_DATASETS.find((d) => d.id === id);
  if (!dataset) throw new Error(`no dataset ${id}`);
  return dataset;
};

describe('what the exports ask of the provider', () => {
  it.each(datasets.map((d) => [d.id, d] as const))('%s: every name it sends is known', (_id, dataset) => {
    const endpoint = PROVIDER[dataset.upstreamPath];
    expect(endpoint).toBeDefined();
    const sample = Object.fromEntries(dataset.params.map((p) => [p.key, p.options?.[0] ?? '1']));
    expect(Object.keys(sourceParams(dataset, sample)).filter((name) => !endpoint.params.includes(name))).toEqual([]);
  });

  it.each(datasets.map((d) => [d.id, d] as const))('%s: its paging and its page size are accepted', (_id, dataset) => {
    const endpoint = PROVIDER[dataset.upstreamPath];
    if (dataset.pagination === 'offset') expect(endpoint.params).toContain('offset');
    if (dataset.pagination === 'cursor') expect(endpoint.params).toContain(dataset.cursorParam ?? 'cursor');
    if (!endpoint.params.includes('limit')) expect(dataset.pagination).toBe('none');
    expect(dataset.pageSize ?? EXPORT_PAGE_SIZE).toBeLessThanOrEqual(endpoint.maxLimit ?? Infinity);
  });

  it('offers no choice the provider refuses', () => {
    for (const dataset of datasets) {
      for (const param of dataset.params) {
        const accepted = ENUMS[`${dataset.upstreamPath} ${param.key}`];
        if (accepted) expect(accepted).toEqual(expect.arrayContaining(param.options ?? []));
      }
    }
    expect(ENUMS['/users/leaderboard window']).toContain(byId('traders-leaderboard').defaults?.window);
  });
});

describe('sourceParams', () => {
  it('writes the window the way each source names it', () => {
    const window = { start_time: '2026-11-10T00:00:00Z', end_time: '2026-11-10T06:00:00Z' };
    expect(sourceParams(byId('perp-fills'), window)).toEqual(window);
    expect(sourceParams(byId('hip3-fills'), { ...window, coin: 'xyz:GOLD' })).toEqual({
      start: window.start_time,
      end: window.end_time,
      coin: 'xyz:GOLD',
    });
    expect(sourceParams(byId('hip4-fills'), window)).toEqual({ start: window.start_time, end: window.end_time });
    expect(sourceParams(byId('completed-trades'), { order: 'asc' })).toEqual({ sort_dir: 'asc' });
  });

  it.each([
    ['2026-11-10T00:00:00Z', '1794268800000'],
    ['2026-11-10T01:00:00+01:00', '1794268800000'],
    // Dates of the export are UTC.
    ['2026-11-10T00:00:00', '1794268800000'],
    ['2026-11-10', '1794268800000'],
    ['1794268800', '1794268800000'],
    ['1794268800000', '1794268800000'],
  ])('gives funding its dates as epoch ms: %s', (value, ms) => {
    expect(sourceParams(byId('funding-history'), { coin: 'BTC', start_time: value })).toEqual({ coin: 'BTC', startTime: ms });
  });

  it('fills in what the caller left empty, and nothing else', () => {
    expect(sourceParams(byId('traders-leaderboard'), {})).toEqual({ window: '7d' });
    expect(sourceParams(byId('traders-leaderboard'), { window: 'all', by: 'pnl' })).toEqual({ window: 'all', by: 'pnl' });
  });
});
