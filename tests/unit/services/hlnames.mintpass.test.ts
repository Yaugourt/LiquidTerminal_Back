/**
 * A mint pass goes straight into a user's wallet transaction: the client only
 * forwards one that is well-formed and matches the label and token asked for.
 */
jest.mock('../../../src/core/redis.service', () => ({ redisService: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HlNamesClient, HLNAMES_USDC } from '../../../src/clients/hlnames/hlnames.client';

function upstream(status: number, body: unknown) {
  (global as any).fetch = jest.fn(async () => ({
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  }));
}

const PASS = { label: 'alice', sig: '0x' + 'ab'.repeat(65), timestamp: 1793059200, token: 'native', amountRequired: '257320776079460655' };

describe('HlNamesClient.mintPass', () => {
  const client = HlNamesClient.getInstance();

  it('forwards a well-formed native pass, without extra fields', async () => {
    upstream(200, { ...PASS, extra: 'x' });
    await expect(client.mintPass('alice', 'native')).resolves.toEqual(PASS);
  });

  it('accepts the USDC pass whatever the address casing', async () => {
    upstream(200, { ...PASS, token: HLNAMES_USDC, amountRequired: '20000000' });
    await expect(client.mintPass('alice', 'usdc')).resolves.toMatchObject({ token: HLNAMES_USDC, amountRequired: '20000000' });
  });

  it('keeps unicode labels that the API echoes as sent', async () => {
    upstream(200, { ...PASS, label: '🐱cat' });
    await expect(client.mintPass('🐱cat', 'native')).resolves.toMatchObject({ label: '🐱cat' });
  });

  it.each([
    ['another label', { label: 'bob' }],
    ['another token', { token: '0x' + '1'.repeat(40) }],
    ['a non-hex signature', { sig: 'nope' }],
    ['a zero amount', { amountRequired: '0' }],
    ['a non-numeric amount', { amountRequired: '1e18' }],
    ['a string timestamp', { timestamp: '1793059200' }],
  ])('refuses a pass with %s', async (_why, patch) => {
    upstream(200, { ...PASS, ...patch });
    await expect(client.mintPass('alice', 'native')).rejects.toThrow('malformed');
  });

  it('refuses an upstream error', async () => {
    upstream(422, { error: 'unknown token' });
    await expect(client.mintPass('alice', 'native')).rejects.toThrow('status 422');
  });
});
