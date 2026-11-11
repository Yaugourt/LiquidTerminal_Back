/**
 * The RPC proxy relayed the node's own error messages as written, to anyone. The node is keyed
 * (the key is in its URL): an error that quotes the URL it was called at, an upstream, a stack,
 * went out with the rest. Errors are now rewritten before they leave.
 */
import { cleanRpcErrors, holdsSecret, rpcSecrets } from '../../../src/services/elysium/elysium-rpc-errors';

const URL_WITH_KEY = 'https://rpc.provider.example/elysium/SECRET-KEY-123456';
const secrets = rpcSecrets(URL_WITH_KEY);
const clean = (answer: unknown): unknown => {
  const out = cleanRpcErrors(Buffer.from(JSON.stringify(answer)), secrets);
  return out === null ? null : JSON.parse(out.toString('utf8'));
};
const error = (message: unknown, extra: Record<string, unknown> = {}, code: unknown = -32000) => ({ jsonrpc: '2.0', id: 7, error: { code, message, ...extra } });

describe('what must never leave', () => {
  it('is the node\'s URL, its host and every part of its path long enough to be a key', () => {
    expect(secrets).toEqual(expect.arrayContaining([URL_WITH_KEY, 'rpc.provider.example', 'SECRET-KEY-123456']));
    // "elysium" is a word of the path, not a key: it must not make every answer suspect.
    expect(secrets).not.toContain('elysium');
    expect(rpcSecrets(null)).toEqual([]);
    expect(rpcSecrets('not a url')).toEqual(['not a url']);
  });
});

describe('cleanRpcErrors', () => {
  it('leaves an answer with no error as it is', () => {
    expect(clean({ jsonrpc: '2.0', id: 7, result: '0x1a2b' })).toBeNull();
    expect(clean([{ jsonrpc: '2.0', id: 1, result: [] }, { jsonrpc: '2.0', id: 2, result: null }])).toBeNull();
    expect(clean({ jsonrpc: '2.0', id: 7, result: 'the word "error" in a result', error: null })).toBeNull();
    expect(cleanRpcErrors(Buffer.from('{"error": not json'), secrets)).toBeNull();
  });

  it('keeps what a builder needs: the code, the revert message and its hex data', () => {
    const data = '0x08c379a0' + '0'.repeat(64);
    expect(clean(error('execution reverted: ERC20: transfer amount exceeds balance', { data }, 3))).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance', data },
    });
    expect(clean(error('header not found'))).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'header not found' } });
  });

  it('replaces a message that quotes the key, the node\'s host, a URL or a host and port', () => {
    const fixed = { jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'Node error' } };
    expect(clean(error(`Post "${URL_WITH_KEY}": context deadline exceeded`))).toEqual(fixed);
    expect(clean(error('quota exceeded for key secret-key-123456'))).toEqual(fixed);
    expect(clean(error('upstream rpc.provider.example unavailable'))).toEqual(fixed);
    expect(clean(error('dial tcp 10.0.3.17:8545: connect: connection refused'))).toEqual(fixed);
    expect(clean(error('backend node-3.internal:8545 timed out'))).toEqual(fixed);
    expect(clean(error('see https://docs.somewhere.example/errors#42'))).toEqual(fixed);
    expect(JSON.stringify(clean(error(`failed at ${URL_WITH_KEY}`, { data: { url: URL_WITH_KEY } })))).not.toContain('SECRET');
  });

  it('says the standard thing for a standard code when the message cannot be kept', () => {
    expect((clean(error(`no method at ${URL_WITH_KEY}`, {}, -32601)) as { error: { message: string } }).error.message).toBe('Method not found');
    expect((clean(error({ nested: true }, {}, -32602)) as { error: { message: string } }).error.message).toBe('Invalid params');
    expect((clean(error('', {}, -32005)) as { error: { message: string } }).error.message).toBe('Limit exceeded');
    expect((clean(error('x', {}, 'not a number')) as { error: { code: number } }).error.code).toBe(-32603);
  });

  it('drops what is not the code, the message and hex data: a stack, an object, a long text', () => {
    const got = clean(error('boom', { data: { stack: 'at handler (/srv/node/rpc.js:12)' }, stack: 'x', cause: 'y' })) as { error: Record<string, unknown> };
    expect(got.error).toEqual({ code: -32000, message: 'boom' });
    expect((clean(error('boom', { data: 'not hex' })) as { error: Record<string, unknown> }).error).toEqual({ code: -32000, message: 'boom' });
    expect((clean(error('boom', { data: '0x' + 'ab'.repeat(10_000) })) as { error: Record<string, unknown> }).error).toEqual({ code: -32000, message: 'boom' });
  });

  it('cuts a long message and takes the control characters out', () => {
    const got = clean(error('line one\nline two\u0000' + 'x'.repeat(500))) as { error: { message: string } };
    expect(got.error.message.startsWith('line one line two x')).toBe(true);
    expect(got.error.message).toHaveLength(301);
  });

  it('does not relay what the node added beside the error: the answer is rebuilt from its id and its error', () => {
    expect(clean({ jsonrpc: '2.0', id: 'abc', error: { code: -32000, message: 'boom' }, debug: { upstream: 'node-7' }, result: 'leftover' })).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      error: { code: -32000, message: 'boom' },
    });
    expect(clean({ error: { code: -32000, message: 'boom' } })).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'boom' } });
  });

  it('rewrites the error of each call of a simulation, which the node reports inside the result', () => {
    const simulated = {
      jsonrpc: '2.0',
      id: 7,
      result: [
        {
          number: '0x10',
          calls: [
            { status: '0x1', returnData: '0x', gasUsed: '0x5208' },
            { status: '0x0', returnData: '0x', error: { code: 3, message: 'execution reverted: nope', data: '0x08c379a0', trace: ['x'] } },
            { status: '0x0', returnData: '0x', error: { code: -32000, message: 'dial tcp 10.0.3.17:8545: i/o timeout' } },
          ],
        },
      ],
    };
    expect(clean(simulated)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: [
        {
          number: '0x10',
          calls: [
            { status: '0x1', returnData: '0x', gasUsed: '0x5208' },
            { status: '0x0', returnData: '0x', error: { code: 3, message: 'execution reverted: nope', data: '0x08c379a0' } },
            { status: '0x0', returnData: '0x', error: { code: -32000, message: 'Node error' } },
          ],
        },
      ],
    });
  });

  /**
   * A contract can revert with a message of tens of kilobytes. The pattern that looks for a
   * URL or a host took 1.4 to 2 s on 60 KB, on the event loop, for every such call.
   */
  it('looks at a long message in a time that does not grow with its square', () => {
    for (const long of ['a'.repeat(250_000), '0x' + 'ab'.repeat(120_000), 'a.'.repeat(120_000), 'execution reverted: ' + 'x-'.repeat(100_000)]) {
      const started = process.hrtime.bigint();
      const got = clean(error(long)) as { error: { message: string } };
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(got.error.message.length).toBeLessThanOrEqual(301);
      expect(ms).toBeLessThan(100);
    }
  });

  it('still catches the key anywhere in a long message, past what is relayed', () => {
    const got = clean(error('x'.repeat(5_000) + ' SECRET-KEY-123456')) as { error: { message: string } };
    expect(got.error.message).toBe('Node error');
  });

  it('rewrites the errors of a batch and leaves its results alone', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, result: '0x10' },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: `upstream ${URL_WITH_KEY} failed`, trace: ['a', 'b'] } },
      { jsonrpc: '2.0', id: 3, error: { code: 3, message: 'execution reverted', data: '0x' } },
    ];
    expect(clean(batch)).toEqual([
      { jsonrpc: '2.0', id: 1, result: '0x10' },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Node error' } },
      { jsonrpc: '2.0', id: 3, error: { code: 3, message: 'execution reverted', data: '0x' } },
    ]);
  });
});

describe('holdsSecret', () => {
  const chunksOf = (text: string, size: number): Buffer[] => {
    const out: Buffer[] = [];
    for (let i = 0; i < text.length; i += size) out.push(Buffer.from(text.slice(i, i + size)));
    return out;
  };

  it('finds the key wherever the chunks are cut, and nothing in an answer without it', () => {
    const body = `{"jsonrpc":"2.0","id":1,"result":"0x${'ab'.repeat(2000)}","note":"SECRET-KEY-123456"}`;
    for (const size of [1, 3, 7, 16, 17, 64, 5000]) expect(holdsSecret(chunksOf(body, size), secrets)).toBe(true);
    const fine = `{"jsonrpc":"2.0","id":1,"result":"0x${'ab'.repeat(2000)}"}`;
    for (const size of [1, 7, 64, 5000]) expect(holdsSecret(chunksOf(fine, size), secrets)).toBe(false);
    expect(holdsSecret(chunksOf(body, 64), [])).toBe(false);
  });
});
