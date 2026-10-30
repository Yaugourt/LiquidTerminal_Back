/**
 * Raw ABI handling for the HyperEVM reads: the Multicall3 request carries one
 * getExpiry call per namehash, and results decode back in order, failed calls
 * as null.
 */
import { expiries, fullRecord } from '../../../src/clients/hlnames/hlnames.chain';

const REG = '0x' + '2'.repeat(40);
const pad = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');

/** ABI encoding of (bool, bytes)[] as aggregate3 returns it. */
function encodeResults(results: { ok: boolean; value?: number }[]): string {
  const tuples = results.map((r) => {
    const data = r.ok && r.value !== undefined ? pad(r.value) : '';
    return pad(r.ok ? 1 : 0) + pad(64) + pad(data.length / 2) + data;
  });
  let offset = results.length * 32;
  const offsets = tuples.map((t) => {
    const o = offset;
    offset += t.length / 2;
    return pad(o);
  });
  return '0x' + pad(32) + pad(results.length) + offsets.join('') + tuples.join('');
}

function rpc(result: string) {
  const fetchMock = jest.fn(async (_url: string, init: { body: string }) => ({
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result }),
  }));
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('hlnames.chain', () => {
  it('encodes one getExpiry per namehash and decodes results in order', async () => {
    const hashes = ['0x' + 'a'.repeat(64), '0x' + 'b'.repeat(64), '0x' + 'c'.repeat(64)];
    const fetchMock = rpc(encodeResults([{ ok: true, value: 1814393087 }, { ok: false }, { ok: true, value: 0 }]));
    await expect(expiries(REG, hashes)).resolves.toEqual([1814393087, null, null]);

    const { params } = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    const data: string = params[0].data;
    expect(params[0].to).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
    expect(data.startsWith('0x82ad56cb')).toBe(true);
    for (const x of hashes) expect(data).toContain('52cc3b21' + x.slice(2));
    expect(data).toContain('2'.repeat(40));
    // selector + offset + length + 3 offsets + 3 tuples of 6 words
    expect((data.length - 10) / 64).toBe(2 + 3 + 3 * 6);
  });

  it('rejects a multicall answer of the wrong length', async () => {
    rpc(encodeResults([{ ok: true, value: 1 }]));
    await expect(expiries(REG, ['0x' + 'a'.repeat(64), '0x' + 'b'.repeat(64)])).rejects.toThrow('multicall returned 1');
  });

  it('decodes getFullRecordJSON into records and expiry', async () => {
    const json = JSON.stringify({ name: { name: 'x.hl', expiry: '1897560632' }, data: { records: { Bio: 'hi', Avatar: 'https://a/b.png', n: 3 } } });
    const hex = Buffer.from(json, 'utf8').toString('hex');
    rpc('0x' + pad(32) + pad(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0'));
    await expect(fullRecord(REG, '0x' + 'a'.repeat(64))).resolves.toEqual({
      records: { Bio: 'hi', Avatar: 'https://a/b.png' },
      expiry: 1897560632,
    });
  });
});
