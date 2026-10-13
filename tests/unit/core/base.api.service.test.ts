/**
 * BaseApiService retries: a 429 from Hyperliquid /info is not retried (the
 * weight budget is one per IP for the whole backend: retrying spends more of
 * it), every other upstream keeps its retries, and 5xx are retried everywhere.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { BaseApiService, HttpApiError, isHyperliquidInfoUrl } from '../../../src/core/base.api.service';

class Client extends BaseApiService {}

const reply = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    // Retry-After 0: the retries under test run without waiting.
    headers: { 'content-type': 'application/json', 'retry-after': '0' },
  });

describe('BaseApiService retries', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('recognises Hyperliquid /info base URLs only', () => {
    expect(isHyperliquidInfoUrl('https://api.hyperliquid.xyz/info')).toBe(true);
    expect(isHyperliquidInfoUrl('https://api-ui.hyperliquid.xyz/info')).toBe(true);
    expect(isHyperliquidInfoUrl('https://stats-data.hyperliquid.xyz/Mainnet')).toBe(false);
    expect(isHyperliquidInfoUrl('https://api.hypedexer.com')).toBe(false);
  });

  it('fails a Hyperliquid /info 429 at once', async () => {
    fetchMock.mockResolvedValue(reply(429));
    const client = new Client('https://api.hyperliquid.xyz/info');
    await expect(client.post('', { type: 'globalStats' })).rejects.toMatchObject({ statusCode: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a Hyperliquid /info 5xx', async () => {
    fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, { ok: true }));
    const client = new Client('https://api.hyperliquid.xyz/info');
    await expect(client.post('', { type: 'globalStats' })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying 429s of other upstreams', async () => {
    fetchMock.mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200, { ok: true }));
    const client = new Client('https://api.hypurrscan.io');
    await expect(client.get('/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('carries the status on the error', async () => {
    fetchMock.mockResolvedValue(reply(429));
    const client = new Client('https://api.hyperliquid.xyz/info');
    const error = await client.post('', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpApiError);
  });
});
