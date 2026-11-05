/**
 * BaseApiService retries: a 429 from Hyperliquid /info is not retried (the
 * weight budget is one per IP for the whole backend: retrying spends more of
 * it), every other upstream keeps its retries, and 5xx are retried everywhere.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { BaseApiService, HttpApiError, isHyperliquidInfoUrl } from '../../../src/core/base.api.service';
import { HyperliquidLeaderboardClient } from '../../../src/clients/hyperliquid/leaderboard/leaderboard.client';

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

/**
 * Response ceiling: a body over 32 MB (from its Content-Length) is refused
 * before it is read, except where a client raises its own ceiling. The
 * stats-data leaderboard file is ~40 MB: refused from 2026-11-02 to 11-05.
 */
describe('BaseApiService response ceiling', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  /** Size of the stats-data leaderboard file on 2026-11-05. */
  const LEADERBOARD_BYTES = 39_993_291;

  class SingleAttemptClient extends BaseApiService {
    once<T>(endpoint: string): Promise<T> {
      return this.getSingleAttempt<T>(endpoint);
    }
  }

  /** A 200 whose Content-Length says `bytes` (the body itself stays small). */
  const sized = (bytes: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(bytes) },
    });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('refuses a body over 32 MB and cancels it unread', async () => {
    const response = sized(LEADERBOARD_BYTES, { ok: true });
    const body = response.body;
    if (!body) throw new Error('the test response has no body');
    const cancel = jest.spyOn(body, 'cancel');
    fetchMock.mockResolvedValue(response);

    const client = new SingleAttemptClient('https://api.hypurrscan.io');
    await expect(client.once('/x')).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('Upstream response too large (39993291 bytes)'),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reads a body up to 32 MB', async () => {
    fetchMock.mockResolvedValue(sized(32 * 1024 * 1024, { ok: true }));
    const client = new SingleAttemptClient('https://api.hypurrscan.io');
    await expect(client.once('/x')).resolves.toEqual({ ok: true });
  });

  it('the leaderboard client reads the ~40 MB file', async () => {
    fetchMock.mockResolvedValue(sized(LEADERBOARD_BYTES, { leaderboardRows: [{ ethAddress: '0xabc' }] }));
    const data = await HyperliquidLeaderboardClient.getInstance().getLeaderboardData();
    expect(data?.leaderboardRows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
      expect.anything()
    );
  });
});
