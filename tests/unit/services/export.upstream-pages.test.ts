/**
 * The export stream reports each page read from the paid upstream, so the
 * route can tell a cheap cancel from one that already spent real credits.
 * Local (DB-backed) datasets cost nothing and are never counted.
 */
const mockFetchPage = jest.fn();
jest.mock('../../../src/clients/hypedexer/rest/export/export-passthrough.client', () => ({
  ExportPassthroughClient: { getInstance: () => ({ fetchPage: mockFetchPage }) },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ExportService } from '../../../src/services/export/export.service';
import { getExportDataset, type ExportDataset } from '../../../src/services/export/export.manifest';
import { EXPORT_PAGE_SIZE } from '../../../src/constants/export.constants';

/** `n` rows numbered from `from`: two pages of a walk never hold the same rows. */
const fullPage = (n: number, from = 0) => ({
  rows: Array.from({ length: n }, (_, i) => ({ tid: from + i, coin: 'BTC' })),
  nextCursor: null,
  hasMore: null,
  totalCount: null,
});

async function drain(stream: AsyncGenerator<string, unknown, void>, stopAfter = Infinity): Promise<number> {
  let chunks = 0;
  for await (const _chunk of stream) {
    chunks += 1;
    if (chunks >= stopAfter) break;
  }
  return chunks;
}

describe('ExportService.streamCsv upstream page count', () => {
  const dataset = getExportDataset('perp-fills') as ExportDataset;

  beforeEach(() => mockFetchPage.mockReset());

  it('reports every upstream page it reads', async () => {
    mockFetchPage
      .mockResolvedValueOnce(fullPage(EXPORT_PAGE_SIZE))
      .mockResolvedValueOnce(fullPage(EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE))
      .mockResolvedValueOnce(fullPage(10, 2 * EXPORT_PAGE_SIZE));
    const onPage = jest.fn();

    const chunks = await drain(ExportService.getInstance().streamCsv(dataset, {}, undefined, onPage));

    expect(onPage).toHaveBeenCalledTimes(3);
    expect(chunks).toBe(1 + 2 * EXPORT_PAGE_SIZE + 10);
  });

  it('has only counted the pages read so far when the consumer stops early', async () => {
    mockFetchPage.mockResolvedValue(fullPage(EXPORT_PAGE_SIZE));
    const onPage = jest.fn();

    // Header + the first page, then the client goes away.
    await drain(ExportService.getInstance().streamCsv(dataset, {}, undefined, onPage), 1 + EXPORT_PAGE_SIZE);

    expect(onPage).toHaveBeenCalledTimes(1);
    expect(mockFetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not count pages of a local dataset', async () => {
    const local = { ...dataset, id: 'local-test', source: 'local' as const };
    const onPage = jest.fn();
    // No resolver registered for this id: the stream fails on page 1, before any count.
    await expect(drain(ExportService.getInstance().streamCsv(local, {}, undefined, onPage))).rejects.toThrow(
      'No local resolver registered'
    );
    expect(onPage).not.toHaveBeenCalled();
    expect(mockFetchPage).not.toHaveBeenCalled();
  });
});

describe('ExportService.streamCsv ceiling', () => {
  const dataset = getExportDataset('perp-fills') as ExportDataset;
  const small = { ...dataset, maxRows: 7 };

  beforeEach(() => mockFetchPage.mockReset());

  async function run(ds: ExportDataset, onFirstPage?: (i: { totalCount: number | null }) => void) {
    const gen = ExportService.getInstance().streamCsv(ds, {}, undefined, undefined, onFirstPage);
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  it('reports the source total before the first chunk and flags the cut', async () => {
    mockFetchPage.mockResolvedValue({ ...fullPage(7), hasMore: true, totalCount: 20 });
    const seen: Array<number | null> = [];

    const result = await run(small, ({ totalCount }) => seen.push(totalCount));

    expect(seen).toEqual([20]);
    expect(result).toEqual({ rowCount: 7, truncated: true });
  });

  it('is not truncated when the ceiling lands exactly on the last row', async () => {
    mockFetchPage.mockResolvedValue({ ...fullPage(7), hasMore: false, totalCount: 7 });

    expect(await run(small)).toEqual({ rowCount: 7, truncated: false });
  });

  it('is not truncated when the data ends before the ceiling', async () => {
    mockFetchPage.mockResolvedValue({ ...fullPage(3), hasMore: false, totalCount: 3 });

    expect(await run(small)).toEqual({ rowCount: 3, truncated: false });
  });

  it('assumes a cut when the source gives no total and the last page was full', async () => {
    mockFetchPage.mockResolvedValue(fullPage(7));

    expect(await run(small)).toEqual({ rowCount: 7, truncated: true });
  });
});

describe('ExportService.streamCsv and how each source pages', () => {
  beforeEach(() => mockFetchPage.mockReset());

  async function run(id: string, over: Partial<ExportDataset> = {}, params: Record<string, string> = {}) {
    const dataset = { ...(getExportDataset(id) as ExportDataset), ...over };
    const gen = ExportService.getInstance().streamCsv(dataset, params);
    const lines: string[] = [];
    let next = await gen.next();
    while (!next.done) {
      lines.push(String(next.value).trimEnd());
      next = await gen.next();
    }
    return { lines, result: next.value };
  }
  const asked = () => mockFetchPage.mock.calls.map(([, params]) => params as Record<string, unknown>);

  it('walks a source that takes no offset by its cursor', async () => {
    mockFetchPage
      .mockResolvedValueOnce({ ...fullPage(500), nextCursor: '1794290399334:7', hasMore: true })
      .mockResolvedValueOnce({ ...fullPage(500, 500), nextCursor: '1794290000000:9', hasMore: true })
      .mockResolvedValueOnce({ ...fullPage(500, 1000), nextCursor: null, hasMore: null });

    const { lines, result } = await run('liquidations', {}, { coin: 'BTC' });

    expect(asked()).toEqual([
      { coin: 'BTC', limit: 500 },
      { coin: 'BTC', limit: 500, cursor: '1794290399334:7' },
      { coin: 'BTC', limit: 500, cursor: '1794290000000:9' },
    ]);
    expect(lines).toHaveLength(1 + 1500);
    expect(result).toEqual({ rowCount: 1500, truncated: false });
  });

  it('walks the traders by page number, every page the same size up to the ceiling', async () => {
    let page = 0;
    mockFetchPage.mockImplementation(async () => {
      page += 1;
      return { ...fullPage(500, (page - 1) * 500), nextCursor: String(page + 1), hasMore: true, totalCount: 224_149 };
    });

    // A ceiling that is not a whole number of pages: the last page is still asked whole.
    const { lines, result } = await run('traders-leaderboard', { maxRows: 1200 }, { by: 'pnl' });

    expect(asked()).toEqual([
      { window: '7d', by: 'pnl', limit: 500 },
      { window: '7d', by: 'pnl', limit: 500, page: '2' },
      { window: '7d', by: 'pnl', limit: 500, page: '3' },
    ]);
    expect(lines.slice(1).map((l) => Number(l.split(',')[0]))).toEqual(Array.from({ length: 1200 }, (_, i) => i));
    expect(result).toEqual({ rowCount: 1200, truncated: true });
  });

  it('starts each offset page where the rows read so far end, whatever the size of the last one', async () => {
    mockFetchPage.mockImplementation(async (_path: string, q: { limit: number; offset?: number }) =>
      fullPage(q.limit, q.offset ?? 0)
    );

    const { lines } = await run('perp-fills', { maxRows: 1300 });

    expect(asked()).toEqual([{ limit: 500 }, { limit: 500, offset: 500 }, { limit: 300, offset: 1000 }]);
    expect(new Set(lines.slice(1)).size).toBe(1300);
  });

  it('stops when a source answers the same page twice, instead of copying it up to the ceiling', async () => {
    mockFetchPage.mockResolvedValue({ ...fullPage(500), totalCount: 500 });

    const { lines, result } = await run('perp-fills');

    expect(mockFetchPage).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1 + 500);
    expect(result).toEqual({ rowCount: 500, truncated: true });
  });

  it('asks once a source that gives everything at once', async () => {
    mockFetchPage.mockResolvedValue(fullPage(1933));

    const { lines, result } = await run('builders');

    expect(mockFetchPage).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1 + 1933);
    expect(result).toEqual({ rowCount: 1933, truncated: false });
  });

  it('writes once a row its source gives twice', async () => {
    mockFetchPage.mockResolvedValue({
      ...fullPage(0),
      rows: [
        { token_id: '0xa', name: 'A', updated_at: '2026-11-25T14:50:18' },
        { token_id: '0xb', name: 'B', updated_at: '2026-11-25T14:50:18' },
        { token_id: '0xa', name: 'A', updated_at: '2026-11-25T14:49:47' },
      ],
    });

    const { lines, result } = await run('spot-tokens');

    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['0xa', '0xb']);
    expect(result).toEqual({ rowCount: 2, truncated: false });
  });
});
