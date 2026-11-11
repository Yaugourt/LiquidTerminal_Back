/**
 * One value the database refuses used to fail its whole page, on every run, for good
 * (2026-11-11). What a provider row or a log may carry is now cleaned and bounded before it
 * is written, and a row the database still refuses is found by halves and set aside.
 */
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistorical: {} }));
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { getClient: () => ({ set: jest.fn().mockResolvedValue('OK') }), delete: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/utils/logger', () => ({ rawLogger: { info: jest.fn().mockResolvedValue(undefined) } }));

import {
  boundedText,
  isRowRefusal,
  normalizeBridgeTransfer,
  normalizeToken,
  normalizeTx,
  pgErrorCode,
  scaleRawAmount,
  storableText,
} from '../../../src/services/elysium/elysium-ingest.util';
import { DEX_TOPICS, decodePoolCreated, decodeSwap } from '../../../src/services/elysium/elysium-dex.util';
import { LAUNCHPAD_TOPICS, decodeLaunch } from '../../../src/services/elysium/elysium-launchpad.util';
import { ElysiumIngestionService } from '../../../src/services/elysium/elysium-ingestion.service';
import type { IngestRejects } from '../../../src/services/elysium/elysium-ingest-rejects';

const ADDR = (c: string): string => `0x${c.repeat(40)}`;
const HASH = (c: string): string => `0x${c.repeat(64)}`;
const topicOf = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;

/** The error Prisma (pg adapter) throws when Postgres refuses a statement, as captured on a real database. */
const pgError = (code: string, message: string): Error =>
  Object.assign(new Error(`\nInvalid \`prisma.$queryRawUnsafe()\` invocation:\n\n\nRaw query failed. Code: \`${code}\`. Message: \`${message}\``), {
    code: 'P2010',
    meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: code, originalMessage: message } } },
  });

describe('text Postgres can store', () => {
  it('removes NUL, control characters and half surrogate pairs, and keeps everything else', () => {
    expect(storableText('pe\u0000pe')).toBe('pepe');
    expect(storableText('a\ud800b')).toBe('ab');
    expect(storableText('a\udc00b')).toBe('ab');
    expect(storableText('ok \u{1F680} 中文 é\ttab\nline')).toBe('ok \u{1F680} 中文 é\ttab\nline');
    expect(() => JSON.parse(JSON.stringify(storableText('x\ud83dy')))).not.toThrow();
  });

  it('cuts a text to its column without leaving half a pair behind, and says when it cut', () => {
    const cut: string[] = [];
    expect(boundedText('  abcdef  ', 4, (v) => cut.push(v))).toBe('abcd');
    expect(cut).toEqual(['abcdef']);
    expect(boundedText('abc\u{1F680}', 4)).toBe('abc');
    expect(boundedText('\u0000  ', 10)).toBeNull();
    expect(boundedText(42, 10)).toBeNull();
  });
});

describe('provider rows', () => {
  it('stores a token whose name carries a NUL or half a pair, cleaned, and cuts a long symbol', () => {
    const row = normalizeToken({ address: ADDR('a').toUpperCase().replace('0X', '0x'), name: 'bad\u0000na\ud800me', symbol: 'S'.repeat(300), decimals: 18, transfer_count: 3 });
    expect(row).toMatchObject({ address: ADDR('a'), name: 'badname', decimals: 18, standard: 'erc20' });
    expect(row?.symbol).toHaveLength(128);
  });

  it('keeps a token with an absurd decimals value, without the value', () => {
    expect(normalizeToken({ address: ADDR('a'), decimals: 1e12 })?.decimals).toBeNull();
    expect(normalizeToken({ address: ADDR('a'), decimals: -1 })?.decimals).toBeNull();
    expect(normalizeToken({ address: ADDR('a'), decimals: 6 })?.decimals).toBe(6);
  });

  it('leaves out a token whose address is not one', () => {
    expect(normalizeToken({ address: '0x123' })).toBeNull();
    expect(normalizeToken({ address: `${ADDR('a')}ff` })).toBeNull();
  });

  it('stores a bridge transfer with a status longer than its column, cut, and reports it', () => {
    const cut: string[] = [];
    const row = normalizeBridgeTransfer(
      { transfer_id: 'd:1', initiated_time: '2026-11-11T10:00:00', status: 'a_status_the_provider_added_since', direction: 'deposit' },
      (field, value) => cut.push(`${field}=${value}`)
    );
    expect(row?.status).toBe('a_status_the_provider_ad');
    expect(row?.status).toHaveLength(24);
    expect(cut).toEqual(['status=a_status_the_provider_added_since']);
  });

  it('drops what would not fit from a bridge transfer and keeps the transfer', () => {
    const row = normalizeBridgeTransfer({
      transfer_id: 'w:9',
      initiated_time: '2026-11-11T10:00:00',
      decimals: 4_000_000_000,
      amount_raw: '5',
      amount: 1e300,
      from_addr: 'not an address',
      l1_tx_hash: `${HASH('a')}00`,
      l2_tx_hash: HASH('b'),
    });
    // An amount that cannot be scaled (a decimals no token has) and no usable figure beside it: unknown, not raw.
    expect(row).toMatchObject({ transfer_id: 'w:9', decimals: null, amount: null, from_addr: null, l1_tx_hash: null, l2_tx_hash: HASH('b') });
  });

  it('never stores a raw amount as if it had no decimals when the decimals given is not one a token has', () => {
    const base = { transfer_id: 'd:5', initiated_time: '2026-11-11T10:00:00', amount_raw: '1000000000000000000' };
    // 1 token stored as 10^18 tokens would have been the result.
    expect(normalizeBridgeTransfer({ ...base, decimals: 300 })?.amount).toBeNull();
    // The provider's own scaled figure is used when it gives one.
    expect(normalizeBridgeTransfer({ ...base, decimals: 300, amount: 1 })?.amount).toBe('1');
    expect(normalizeBridgeTransfer({ ...base, decimals: 18 })?.amount).toBe('1');
    // No decimals given at all: the raw amount, as before.
    expect(normalizeBridgeTransfer({ ...base })?.amount).toBe('1000000000000000000');
  });

  it('leaves out a bridge transfer whose id would have to be cleaned or cut', () => {
    expect(normalizeBridgeTransfer({ transfer_id: `d:${'9'.repeat(90)}`, initiated_time: '2026-11-11T10:00:00' })).toBeNull();
    expect(normalizeBridgeTransfer({ transfer_id: 'd:\u00001', initiated_time: '2026-11-11T10:00:00' })).toBeNull();
  });

  it('never pads an amount to an absurd number of decimals', () => {
    expect(scaleRawAmount('5', 1_000_000_000)).toBeNull();
    expect(scaleRawAmount('1500000', 6)).toBe('1.5');
  });

  const tx = (over: Record<string, unknown> = {}) => ({
    tx_hash: HASH('1'),
    from_addr: ADDR('a'),
    to_addr: ADDR('b'),
    block_number: 10,
    block_time: '2026-11-11T10:00:00',
    gas_used: 21000,
    effective_gas_price: 2,
    success: true,
    ...over,
  });

  it('maps a transaction as before', () => {
    expect(normalizeTx(tx({ method_id: '0xa9059cbb', tx_type: '0x2' }))).toMatchObject({
      tx_hash: HASH('1'),
      to_addr: ADDR('b'),
      contract_address: null,
      method_id: '0xa9059cbb',
      tx_type: '0x2',
      gas_used: '21000',
      fee_wei: '42000',
    });
    expect(normalizeTx(tx({ to_addr: null, contract_address: ADDR('c') }))).toMatchObject({ to_addr: null, contract_address: ADDR('c') });
  });

  it('takes a gas that is not there yet, and a target written as a bare 0x, as the provider may send them', () => {
    expect(normalizeTx(tx({ gas_used: '' }))).toMatchObject({ gas_used: '0', fee_wei: '0' });
    expect(normalizeTx(tx({ gas_used: null }))).toMatchObject({ gas_used: '0' });
    // A contract creation whose target is "0x": kept, as a creation.
    expect(normalizeTx(tx({ to_addr: '0x', contract_address: ADDR('c') }))).toMatchObject({ to_addr: null, contract_address: ADDR('c') });
  });

  it('leaves out a transaction whose hash, target or numbers would not fit their columns', () => {
    expect(normalizeTx(tx({ tx_hash: '0xabc' }))).toBeNull();
    // A target that is there but is not an address: storing it as null would make the call a contract creation.
    expect(normalizeTx(tx({ to_addr: 'garbage' }))).toBeNull();
    expect(normalizeTx(tx({ contract_address: `${ADDR('c')}0` }))).toBeNull();
    expect(normalizeTx(tx({ gas_used: '99999999999999999999999999' }))).toBeNull();
    expect(normalizeTx(tx({ block_number: '99999999999999999999999999' }))).toBeNull();
    expect(normalizeTx(tx({ gas_used: '9000000000000000000', effective_gas_price: '9'.repeat(30) }))).toBeNull();
  });
});

describe('logs', () => {
  const log = (over: Record<string, unknown>) => ({
    block_time: '2026-11-11T10:00:00',
    block_number: 123,
    log_index: 4,
    tx_hash: HASH('1'),
    address: ADDR('f'),
    topic1: topicOf(ADDR('a')),
    topic2: topicOf(ADDR('b')),
    topic3: '',
    data: '0x',
    ...over,
  });

  it('stores a V3 pool whose fee topic is not a fee without the fee (it failed the page of pools)', () => {
    const word = (hex: string): string => hex.padStart(64, '0');
    const data = `0x${word('3c')}${word(ADDR('c').slice(2))}`;
    const fee = (hex: string) => decodePoolCreated(log({ topic0: DEX_TOPICS.v3PoolCreated, topic3: `0x${word(hex)}`, data }))?.fee;
    expect(fee('bb8')).toBe(3000);
    expect(fee('ffffff')).toBe(0xffffff);
    expect(fee('10000000000')).toBeNull(); // 2^40: a safe integer, and not an integer column's
    expect(fee('f'.repeat(64))).toBeNull();
  });

  it('leaves out a log whose index or identifiers would not fit their columns', () => {
    const word = (n: number): string => n.toString(16).padStart(64, '0');
    const swap = (over: Record<string, unknown>) => decodeSwap(log({ topic0: DEX_TOPICS.v2Swap, data: `0x${word(5)}${word(0)}${word(0)}${word(7)}`, ...over }));
    expect(swap({})).toMatchObject({ log_index: 4, amount0: '5', amount1: '-7' });
    expect(swap({ log_index: 3_000_000_000 })).toBeNull();
    expect(swap({ log_index: -1 })).toBeNull();
    expect(swap({ tx_hash: '0xabc' })).toBeNull();
    expect(swap({ address: 'x'.repeat(60) })).toBeNull();
  });

  /** ABI data of Kiln TokenLaunched: (string name, string symbol, string uri, uint256 graduationTarget). */
  const kilnData = (name: string, symbol: string): string => {
    const word = (n: number): string => n.toString(16).padStart(64, '0');
    const str = (text: string): string => {
      const hex = Buffer.from(text, 'utf8').toString('hex');
      return word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
    };
    const [a, b, c] = [str(name), str(symbol), str('')];
    return `0x${word(128)}${word(128 + a.length / 2)}${word(128 + (a.length + b.length) / 2)}${word(1)}${a}${b}${c}`;
  };
  const kiln = (name: string, symbol: string) =>
    decodeLaunch(log({ topic0: LAUNCHPAD_TOPICS.kilnLaunch, address: '0x18defd8b02b9cea88a5d5c031ee29573aa78c63a', topic3: topicOf(ADDR('d')), data: kilnData(name, symbol) }));

  it('reads a launch name and symbol as before', () => {
    expect(kiln('Pepe the Frog', 'PEPE')).toMatchObject({ launchpad: 'Kiln', name: 'Pepe the Frog', symbol: 'PEPE', token: ADDR('a'), curve: ADDR('b') });
  });

  it('cuts a symbol longer than its column (it failed the whole page of launches, on every run)', () => {
    const row = kiln('n', 'S'.repeat(200));
    expect(row?.symbol).toHaveLength(128);
    expect(row?.name).toBe('n');
  });

  it('cleans the control characters of a name its creator chose', () => {
    expect(kiln('bad\u0000 \u0007name', 'OK')?.name).toBe('bad name');
  });
});

describe('telling a refused row from a broken statement', () => {
  it('reads the SQLSTATE from the driver error, or from the message', () => {
    expect(pgErrorCode(pgError('22P05', 'unsupported Unicode escape sequence'))).toBe('22P05');
    expect(pgErrorCode(new Error('Raw query failed. Code: `22001`. Message: `value too long`'))).toBe('22001');
    expect(pgErrorCode(new Error('connection terminated'))).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
  });

  it('counts only the refusals caused by the data', () => {
    for (const code of ['22P05', '22P02', '22001', '22003', '23502']) expect(isRowRefusal(pgError(code, 'x'))).toBe(true);
    // A time limit, a deadlock, a missing column, a lost connection: not a row to look for.
    for (const code of ['57014', '40P01', '42703', '08006']) expect(isRowRefusal(pgError(code, 'x'))).toBe(false);
    expect(isRowRefusal(new Error('Timed out fetching a new connection from the connection pool'))).toBe(false);
  });
});

describe('Elysium ingestion: a refused row is set aside', () => {
  type Writer = {
    rejects: IngestRejects;
    writeRows: <T>(stream: string, rows: T[], write: (rows: T[]) => Promise<number>, describe: (row: T) => string) => Promise<number>;
  };
  let svc: Writer;
  let statements: number;
  /** A database that refuses any statement holding one of the `bad` rows. */
  const database = (bad: Set<number>, error = pgError('22001', 'value too long for type character varying(16)')) => {
    const stored: number[] = [];
    const write = async (rows: number[]): Promise<number> => {
      statements++;
      if (rows.some((r) => bad.has(r))) throw error;
      stored.push(...rows);
      return rows.length;
    };
    return { stored, write };
  };
  const page = Array.from({ length: 1000 }, (_, i) => i);

  beforeEach(() => {
    (ElysiumIngestionService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumIngestionService.getInstance() as unknown as Writer;
    statements = 0;
  });

  it('writes a clean page in one statement', async () => {
    const db = database(new Set());
    expect(await svc.writeRows('tokens', page, db.write, String)).toBe(1000);
    expect(statements).toBe(1);
    expect(svc.rejects.take()).toEqual([]);
  });

  it('stores the 999 other rows of a page with one refused row, in about 20 statements', async () => {
    const db = database(new Set([637]));
    expect(await svc.writeRows('tokens', page, db.write, (r) => `row ${r}`)).toBe(999);
    expect(db.stored.sort((a, b) => a - b)).toEqual(page.filter((r) => r !== 637));
    expect(statements).toBeLessThanOrEqual(21);
    expect(svc.rejects.take()).toEqual([{ stream: 'tokens', reason: 'row-refused', count: 1, sample: '22001 row 637' }]);
  });

  it('does not search again for a row it set aside when the same rows come back (a window read again)', async () => {
    const db = database(new Set([637]));
    await svc.writeRows('tokens', page, db.write, (r) => `row ${r}`);
    svc.rejects.take();
    statements = 0;

    expect(await svc.writeRows('tokens', page, db.write, (r) => `row ${r}`)).toBe(999);
    expect(statements).toBe(1);
    expect(svc.rejects.take()).toEqual([]);
    // The same key in another stream is another row.
    await svc.writeRows('bridge', page, db.write, (r) => `row ${r}`);
    expect(svc.rejects.take()).toEqual([expect.objectContaining({ stream: 'bridge', count: 1 })]);
  });

  it('sets several refused rows aside', async () => {
    const db = database(new Set([0, 1, 500, 999]));
    expect(await svc.writeRows('bridge', page, db.write, String)).toBe(996);
    expect(svc.rejects.take()).toEqual([expect.objectContaining({ stream: 'bridge', reason: 'row-refused', count: 4 })]);
  });

  it('gives the page up when more than 25 of its rows are refused: that is not a bad row any more', async () => {
    const db = database(new Set(page.filter((r) => r % 30 === 0)));
    await expect(svc.writeRows('tx', page, db.write, String)).rejects.toThrow('value too long');
  });

  it('throws at once what is not about the data, without looking for a row', async () => {
    const db = database(new Set([3]), pgError('57014', 'canceling statement due to statement timeout'));
    await expect(svc.writeRows('tx', page, db.write, String)).rejects.toThrow('statement timeout');
    expect(statements).toBe(1);
    expect(svc.rejects.take()).toEqual([]);
  });
});
