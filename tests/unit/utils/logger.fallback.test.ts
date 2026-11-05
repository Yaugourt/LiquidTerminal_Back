/**
 * In production the image runs as `node` and cannot create /app/logs, so the
 * logger falls back to stdout/stderr. That fallback used to drop the base
 * config, redaction included: request bodies, emails and Privy ids reached
 * the Railway logs in clear (found 2026-11-05).
 */
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    mkdir: jest.fn(async () => {
      throw Object.assign(new Error("EACCES: permission denied, mkdir '/app/logs'"), { code: 'EACCES' });
    }),
  };
});

describe('logger without log files', () => {
  it('keeps the redaction, the level labels and the service name', async () => {
    const setupError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    };
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
    try {
      const { rawLogger } = await import('../../../src/utils/logger');
      // initializeLogger() runs at import; let its failed mkdir settle.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await rawLogger.error('Error creating read list:', {
        error: 'boom',
        body: { note: 'private note' },
        privyUserId: 'did:privy:SECRET123',
        email: 'someone@example.com',
      });
      // Checked before the restore below, which clears the recorded calls.
      expect(setupError).toHaveBeenCalledWith(
        'Logger setup failed, logging to stdout/stderr only:',
        expect.stringContaining('EACCES')
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      setupError.mockRestore();
    }

    const line = written.join('');
    expect(line).toContain('"level":"error"');
    expect(line).toContain('"service":"liquidterminal-api"');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('"error":"boom"');
    expect(line).not.toContain('private note');
    expect(line).not.toContain('did:privy:SECRET123');
    expect(line).not.toContain('someone@example.com');
  });
});
