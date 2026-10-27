/**
 * The `unstaking-queue` export must walk the whole queue. UnstakingService
 * clamps a page at 200 rows; the dataset used to ask for 500, got 200 back, and
 * stopped after page 1 as if that were the end (queue ~1,500 entries).
 */
const mockGetUnstakingQueue = jest.fn();
jest.mock('../../../src/services/staking/unstaking.service', () => ({
  UnstakingService: { getInstance: () => ({ getUnstakingQueue: mockGetUnstakingQueue }) },
}));
jest.mock('../../../src/clients/hypedexer/rest/export/export-passthrough.client', () => ({
  ExportPassthroughClient: { getInstance: () => ({ fetchPage: jest.fn() }) },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ExportService } from '../../../src/services/export/export.service';
import { getExportDataset, type ExportDataset } from '../../../src/services/export/export.manifest';

const SERVICE_MAX_LIMIT = 200;
const TOTAL = 450;

describe('unstaking-queue export', () => {
  it('exports every row of a queue longer than the service page cap', async () => {
    // Same clamp and pagination envelope as UnstakingService.getUnstakingQueue.
    mockGetUnstakingQueue.mockImplementation(async ({ limit, page }: { limit: number; page: number }) => {
      const size = Math.min(SERVICE_MAX_LIMIT, limit);
      const start = (page - 1) * size;
      const data = Array.from({ length: Math.max(0, Math.min(size, TOTAL - start)) }, (_, i) => ({
        id: start + i,
      }));
      return { data, pagination: { total: TOTAL } };
    });

    const dataset = getExportDataset('unstaking-queue') as ExportDataset;
    const lines: string[] = [];
    for await (const chunk of ExportService.getInstance().streamCsv(dataset, {})) lines.push(chunk);

    expect(lines).toHaveLength(1 + TOTAL);
    expect(lines[TOTAL]).toBe(`${TOTAL - 1}\n`);
  });

  it('asks for pages the service does not clamp', () => {
    expect(getExportDataset('unstaking-queue')?.pageSize).toBe(SERVICE_MAX_LIMIT);
  });
});
