/**
 * Link preview fetches a URL any visitor picks, so the remote host controls
 * the response's Content-Encoding. axios must not decode it (it would run the
 * Brotli decoder, Node CVE-2026-111497); the service decodes gzip itself with
 * a size cap and refuses everything else.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/utils/ssrf', () => ({
  resolveSafeAddress: jest.fn(async () => ({ address: '93.184.216.34', family: 4 })),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), isAxiosError: () => false },
}));

import axios from 'axios';
import { brotliCompressSync, gzipSync } from 'zlib';
import { LinkPreviewFetcherService } from '../../../src/services/linkPreview/linkPreviewFetcher.service';
import { LinkPreviewFetchError } from '../../../src/errors/linkPreview.errors';

const get = axios.get as jest.Mock;
const page = '<html><head><title>Liquid Terminal</title></head><body></body></html>';

function respond(data: Buffer, contentEncoding?: string): void {
  get.mockResolvedValueOnce({
    status: 200,
    headers: contentEncoding ? { 'content-encoding': contentEncoding } : {},
    data,
  });
}

describe('link preview response decoding', () => {
  const service = LinkPreviewFetcherService.getInstance();

  beforeEach(() => get.mockReset());

  it('asks axios for raw bytes and gzip only', async () => {
    respond(Buffer.from(page));
    await service.fetchPreviewData('https://example.com/');
    const config = get.mock.calls[0][1];
    expect(config.decompress).toBe(false);
    expect(config.responseType).toBe('arraybuffer');
    expect(config.headers['Accept-Encoding']).toBe('gzip');
  });

  it('reads identity and gzip bodies', async () => {
    respond(Buffer.from(page));
    await expect(service.fetchPreviewData('https://example.com/')).resolves.toMatchObject({ title: 'Liquid Terminal' });

    respond(gzipSync(Buffer.from(page)), 'gzip');
    await expect(service.fetchPreviewData('https://example.com/')).resolves.toMatchObject({ title: 'Liquid Terminal' });
  });

  it('reads a truncated or empty gzip body, as axios did', async () => {
    const gzipped = gzipSync(Buffer.from(page));
    respond(gzipped.subarray(0, gzipped.length - 8), 'gzip');
    await expect(service.fetchPreviewData('https://example.com/')).resolves.toMatchObject({ title: 'Liquid Terminal' });

    respond(Buffer.alloc(0), 'gzip');
    await expect(service.fetchPreviewData('https://example.com/')).resolves.toMatchObject({ title: null });
  });

  it.each(['br', 'deflate', 'zstd', 'gzip, br'])('refuses a %s body', async (encoding) => {
    respond(brotliCompressSync(Buffer.from(page)), encoding);
    await expect(service.fetchPreviewData('https://example.com/')).rejects.toBeInstanceOf(LinkPreviewFetchError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('refuses a gzip body that inflates past the size cap', async () => {
    respond(gzipSync(Buffer.alloc(3 * 1024 * 1024)), 'gzip');
    await expect(service.fetchPreviewData('https://example.com/')).rejects.toBeInstanceOf(LinkPreviewFetchError);
  });
});
