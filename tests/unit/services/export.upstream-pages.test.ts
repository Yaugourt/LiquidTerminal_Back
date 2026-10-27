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

const fullPage = (n: number) => ({
  rows: Array.from({ length: n }, (_, i) => ({ tid: i, coin: 'BTC' })),
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
      .mockResolvedValueOnce(fullPage(EXPORT_PAGE_SIZE))
      .mockResolvedValueOnce(fullPage(10));
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
