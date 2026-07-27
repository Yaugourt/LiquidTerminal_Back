import { resolveSafeAddress, assertHostnameNotBlocked, isBlockedIp, SsrfBlockedError } from '../../../src/utils/ssrf';

describe('SSRF guard — IP literals', () => {
  it('flags private / loopback / metadata / internal ranges', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.0.0.5')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('172.16.0.1')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isBlockedIp('::1')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
  });
});

describe('resolveSafeAddress — literal inputs (no DNS)', () => {
  it('returns the vetted address + family for a public literal', async () => {
    await expect(resolveSafeAddress('8.8.8.8')).resolves.toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('throws SsrfBlockedError for a blocked literal', async () => {
    await expect(resolveSafeAddress('127.0.0.1')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveSafeAddress('169.254.169.254')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('assertHostnameNotBlocked rejects a blocked literal', async () => {
    await expect(assertHostnameNotBlocked('10.1.2.3')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
