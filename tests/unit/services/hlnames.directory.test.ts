/**
 * The local copy of primary names: expired or unknown-expiry names never
 * show, unchanged pages are reused on 304, nothing is served before the first
 * full load, and a cache drop after a mint pulls the list at most once a minute.
 */
const chain = {
  currentRegistrator: jest.fn(async () => '0x' + '1'.repeat(40)),
  expiries: jest.fn(),
};
jest.mock('../../../src/clients/hlnames/hlnames.chain', () => chain);
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HlNamesDirectory, ListPageFetcher } from '../../../src/clients/hlnames/hlnames.directory';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const h = (c: string) => '0x' + c.repeat(64);
const NOW = 1_800_000_000_000;
const FUTURE = NOW / 1000 + 86_400;
const PAST = NOW / 1000 - 86_400;

const rows = [
  { address: A.toUpperCase().replace('0X', '0x'), primaryName: 'alice.hl', namehash: h('1') },
  { address: B, primaryName: 'bob.hl', namehash: h('2') },
  { address: C, primaryName: 'carol.hl', namehash: h('3') },
];

describe('HlNamesDirectory', () => {
  let now = NOW;
  beforeEach(() => {
    now = NOW;
    jest.clearAllMocks();
    chain.expiries.mockImplementation(async (_r: string, hashes: string[]) =>
      hashes.map((x) => (x === h('1') ? FUTURE : x === h('2') ? PAST : null))
    );
  });

  it('serves live names only: expired and unknown expiries read as no name', async () => {
    const fetchPage: ListPageFetcher = jest.fn(async () => ({ status: 200 as const, etag: 'e1', rows }));
    const dir = new HlNamesDirectory(fetchPage, () => now);
    expect(dir.primaryName(A)).toBeUndefined(); // not loaded yet
    await dir.refresh();
    expect(dir.ready).toBe(true);
    expect(dir.primaryName(A)).toBe('alice.hl');
    expect(dir.primaryName(B)).toBeNull(); // expired
    expect(dir.primaryName(C)).toBeNull(); // expiry unknown
    expect(dir.primaryName('0x' + 'd'.repeat(40))).toBeNull();
    expect(dir.addressOf('ALICE.hl')).toBe(A);
    expect(dir.addressOf('bob.hl')).toBeNull();
    expect(dir.entry(A)).toEqual({ name: 'alice.hl', namehash: h('1'), expiry: FUTURE });
  });

  it('a name expires in place without a refresh', async () => {
    const dir = new HlNamesDirectory(jest.fn(async () => ({ status: 200 as const, etag: null, rows })), () => now);
    await dir.refresh();
    expect(dir.primaryName(A)).toBe('alice.hl');
    now = FUTURE * 1000 + 1;
    expect(dir.primaryName(A)).toBeNull();
  });

  it('stays unready (callers fall back) while expiries cannot be read', async () => {
    chain.expiries.mockRejectedValueOnce(new Error('rpc down'));
    const dir = new HlNamesDirectory(jest.fn(async () => ({ status: 200 as const, etag: null, rows })), () => now);
    await dir.refresh();
    expect(dir.ready).toBe(false);
    expect(dir.primaryName(A)).toBeUndefined();
  });

  it('pages until a short page, sends the ETag back and reuses a page on 304', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({
      address: '0x' + i.toString(16).padStart(40, '0'),
      primaryName: `n${i}.hl`,
      namehash: '0x' + (i + 1).toString(16).padStart(64, '0'),
    }));
    const fetchPage = jest.fn<ReturnType<ListPageFetcher>, Parameters<ListPageFetcher>>(async (begin, _end, etag) => {
      if (etag) return { status: 304 };
      return begin === 0 ? { status: 200, etag: 'p0', rows: full } : { status: 200, etag: 'p1', rows: [rows[0]] };
    });
    chain.expiries.mockImplementation(async (_r: string, hashes: string[]) => hashes.map(() => FUTURE));
    const dir = new HlNamesDirectory(fetchPage, () => now);
    await dir.refresh();
    expect(fetchPage.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [0, 1000, null],
      [1000, 2000, null],
    ]);
    expect(dir.primaryName(A)).toBe('alice.hl');
    expect(chain.expiries).toHaveBeenCalledTimes(1);

    now += 10 * 60_000;
    await dir.refresh();
    expect(fetchPage.mock.calls.slice(2).map((c) => c[2])).toEqual(['p0', 'p1']);
    expect(dir.primaryName(A)).toBe('alice.hl');
    expect(dir.primaryName('0x' + (5).toString(16).padStart(40, '0'))).toBe('n5.hl');
    // Nothing changed and the hour is not up: no new chain read.
    expect(chain.expiries).toHaveBeenCalledTimes(1);
  });

  it('drops malformed rows', async () => {
    const bad = [
      { address: 'nope', primaryName: 'x.hl', namehash: h('4') },
      { address: C, primaryName: 'not-a-name', namehash: h('5') },
      { address: B, primaryName: 'b.hl', namehash: '0x12' },
      rows[0],
    ];
    const dir = new HlNamesDirectory(jest.fn(async () => ({ status: 200 as const, etag: null, rows: bad })), () => now);
    await dir.refresh();
    expect(chain.expiries.mock.calls[0][1]).toEqual([h('1')]);
  });

  it('refreshSoon pulls the list at most once a minute', async () => {
    const fetchPage = jest.fn(async () => ({ status: 200 as const, etag: null, rows }));
    const dir = new HlNamesDirectory(fetchPage, () => now);
    await dir.refresh();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    dir.refreshSoon();
    await dir.refresh();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    dir.refreshSoon();
    dir.refreshSoon();
    await dir.refresh();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    now += 61_000;
    dir.refreshSoon();
    await dir.refresh();
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});
