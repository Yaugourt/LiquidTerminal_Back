/**
 * Link preview fetches are bounded: a capped wait line, a capped wait, no retry
 * on timeouts and one wall-clock deadline per URL, so slow hosts cannot keep
 * every slot (shared with educational-resource creation) busy.
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
  default: {
    get: jest.fn(),
    isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

import type { LinkPreviewFetcherService } from '../../../src/services/linkPreview/linkPreviewFetcher.service';

// The slot counter is module state: each test loads a fresh copy so a test that
// leaves fetches hanging cannot hold slots for the next one.
let get: jest.Mock;
let service: LinkPreviewFetcherService;
let LinkPreviewFetchError: typeof import('../../../src/errors/linkPreview.errors').LinkPreviewFetchError;
let LinkPreviewTimeoutError: typeof import('../../../src/errors/linkPreview.errors').LinkPreviewTimeoutError;
const page = '<html><head><title>Liquid Terminal</title></head></html>';
const ok = { status: 200, headers: {}, data: Buffer.from(page) };

const axiosError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(code), { isAxiosError: true, code, ...extra });

/** Lets queued microtasks (DNS mock, slot hand-over) run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('link preview fetch bounds', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    get = require('axios').default.get;
    get.mockReset();
    service = require('../../../src/services/linkPreview/linkPreviewFetcher.service').LinkPreviewFetcherService.getInstance();
    ({ LinkPreviewFetchError, LinkPreviewTimeoutError } = require('../../../src/errors/linkPreview.errors'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('fails fast past the wait-line cap, answers the rest, and frees every slot', async () => {
    const hang: Array<(v: unknown) => void> = [];
    get.mockImplementation(() => new Promise((resolve) => hang.push(resolve)));

    // 6 running + 50 waiting fill the line; the next one is refused at once.
    const accepted = Array.from({ length: 56 }, (_, i) => service.fetchPreviewData(`https://h${i}.example.com/`));
    await flush();
    await expect(service.fetchPreviewData('https://over.example.com/')).rejects.toMatchObject({
      message: 'Preview temporarily unavailable',
    });
    await expect(service.fetchPreviewData('https://over.example.com/')).rejects.toBeInstanceOf(LinkPreviewFetchError);
    expect(hang).toHaveLength(6);

    // Drain: every accepted fetch completes, slots are handed over one by one.
    get.mockImplementation(async () => ok);
    hang.forEach((resolve) => resolve(ok));
    const results = await Promise.all(accepted);
    expect(results).toHaveLength(56);
    expect(results[55]).toMatchObject({ title: 'Liquid Terminal' });

    // Nothing leaked: a new fetch gets a slot immediately.
    await expect(service.fetchPreviewData('https://after.example.com/')).resolves.toMatchObject({ title: 'Liquid Terminal' });
  });

  it('gives up on a waiter after the maximum wait, without losing a slot', async () => {
    get.mockImplementation(() => new Promise(() => undefined)); // never answers
    const running = Array.from({ length: 6 }, (_, i) => service.fetchPreviewData(`https://r${i}.example.com/`));
    running.forEach((p) => p.catch(() => undefined));
    await flush();

    const waiter = service.fetchPreviewData('https://wait.example.com/');
    const outcome = waiter.then(() => null, (e) => e);
    await flush();
    jest.advanceTimersByTime(15_000);
    expect(await outcome).toBeInstanceOf(LinkPreviewTimeoutError);
  });

  it('does not retry a timeout', async () => {
    get.mockRejectedValue(axiosError('ECONNABORTED'));
    await expect(service.fetchPreviewData('https://slow.example.com/')).rejects.toBeInstanceOf(LinkPreviewTimeoutError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('still retries a transient 503', async () => {
    get.mockRejectedValueOnce(axiosError('ERR_BAD_RESPONSE', { response: { status: 503 } })).mockResolvedValueOnce(ok);
    const p = service.fetchPreviewData('https://flaky.example.com/');
    await flush();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toMatchObject({ title: 'Liquid Terminal' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('caps a URL with an abort signal and a hop timeout inside the overall deadline', async () => {
    get.mockResolvedValue(ok);
    await service.fetchPreviewData('https://example.com/');
    const config = get.mock.calls[0][1];
    expect(config.timeout).toBeLessThanOrEqual(8_000);
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });

  it('stops following redirects once the overall deadline has passed', async () => {
    let t = 0;
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + t);
    get.mockImplementation(async () => {
      t += 8_000; // each hop eats its full timeout
      return { status: 302, headers: { location: '/next' }, data: Buffer.alloc(0) };
    });
    await expect(service.fetchPreviewData('https://redirects.example.com/')).rejects.toBeInstanceOf(LinkPreviewTimeoutError);
    // 20 s deadline / 8 s per hop: three hops at most, not six.
    expect(get.mock.calls.length).toBeLessThanOrEqual(3);
    jest.restoreAllMocks();
  });
});
