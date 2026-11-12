import {
  errorCategory,
  fillDays,
  lastDays,
  precompileLabel,
  PRECOMPILE_LIKE,
  retentionFraction,
  share,
  toDayKey,
} from '../../../src/services/elysium/elysium-analytics.util';

const pc = (lowByte: string): string => `0x${'0'.repeat(38)}${lowByte}`;

describe('precompileLabel', () => {
  it('labels known Arbitrum precompiles', () => {
    expect(precompileLabel(pc('64'))).toBe('ArbSys');
    expect(precompileLabel(pc('6e'))).toBe('ArbRetryableTx');
    expect(precompileLabel(pc('6c'))).toBe('ArbGasInfo');
    expect(precompileLabel(pc('70'))).toBe('ArbOwner');
    expect(precompileLabel(pc('65'))).toBe('ArbInfo');
    expect(precompileLabel(pc('66'))).toBe('ArbAddressTable');
    expect(precompileLabel(pc('6b'))).toBe('ArbOwnerPublic');
    expect(precompileLabel(pc('68'))).toBe('ArbAggregator');
    expect(precompileLabel(pc('69'))).toBe('ArbStatistics');
    expect(precompileLabel(pc('c8'))).toBe('NodeInterface');
    expect(precompileLabel(pc('C8'))).toBe('NodeInterface');
  });

  it('falls back to Precompile for other low addresses', () => {
    expect(precompileLabel(pc('01'))).toBe('Precompile');
    expect(precompileLabel(pc('ff'))).toBe('Precompile');
  });

  it('returns null for ordinary addresses', () => {
    expect(precompileLabel('0x00000000000000000000000000000000000a4b05')).toBeNull();
    expect(precompileLabel('0x7ae29be60a29425dabc75e361875f1dd21c160a7')).toBeNull();
    expect(precompileLabel('0x64')).toBeNull();
  });

  it('exposes a LIKE pattern of full address length', () => {
    expect(PRECOMPILE_LIKE).toHaveLength(42);
  });
});

describe('day series', () => {
  const now = new Date('2026-09-28T09:00:00Z');

  it('lists the last N UTC days ascending, today included', () => {
    expect(lastDays(now, 3)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    expect(lastDays(new Date('2026-10-01T00:00:00Z'), 2)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('zero-fills missing days and flags only today as partial', () => {
    const rows = new Map([['2026-09-27', { n: 5 }]]);
    expect(fillDays(lastDays(now, 3), rows, () => ({ n: 0 }), now)).toEqual([
      { day: '2026-09-26', partial: false, n: 0 },
      { day: '2026-09-27', partial: false, n: 5 },
      { day: '2026-09-28', partial: true, n: 0 },
    ]);
  });

  it('normalises DB day values', () => {
    expect(toDayKey('2026-09-28')).toBe('2026-09-28');
    expect(toDayKey(new Date('2026-09-28T00:00:00Z'))).toBe('2026-09-28');
  });
});

describe('retentionFraction', () => {
  const now = new Date('2026-09-28T09:00:00Z');

  it('returns the retained share once the offset day is complete', () => {
    expect(retentionFraction('2026-09-20', 1, 200, 50, now)).toBe(0.25);
    expect(retentionFraction('2026-09-20', 7, 200, 20, now)).toBe(0.1);
    // d1 of 2026-09-26 is 2026-09-27, complete at 2026-09-28T00:00Z.
    expect(retentionFraction('2026-09-26', 1, 10, 4, now)).toBe(0.4);
  });

  it('returns null while the offset day is still running or in the future', () => {
    expect(retentionFraction('2026-09-27', 1, 10, 4, now)).toBeNull();
    expect(retentionFraction('2026-09-21', 7, 10, 1, now)).toBeNull();
    expect(retentionFraction('2026-09-28', 1, 10, 0, now)).toBeNull();
  });

  it('returns null for empty cohorts', () => {
    expect(retentionFraction('2026-09-20', 1, 0, 0, now)).toBeNull();
  });

  it('share is 0 on empty totals', () => {
    expect(share(3, 0)).toBe(0);
    expect(share(1, 4)).toBe(0.25);
  });
});

describe('errorCategory', () => {
  it('never returns the raw message (no hosts, no internal addresses)', () => {
    expect(errorCategory('API error: 503 Service Unavailable https://upstream.example/elysium/testnet/transactions')).toBe('upstream_http_503');
    expect(errorCategory("Can't reach database server at `db.railway.internal:5432`")).toBe('db_error');
    expect(errorCategory('Command timed out')).toBe('timeout');
    expect(errorCategory('Elysium ingest: tx tick given up after 300 s without moving on')).toBe('tick_time_limit');
    expect(errorCategory('Elysium ingest: tx tick given up after 1800 s in all')).toBe('tick_time_limit');
    // What the upkeep pass refuses to do, said by name.
    expect(errorCategory('ELYSIUM_TX_KEEP_DAYS is set but elysium_tx is not split by day: set ELYSIUM_TX_SPLIT_ENABLED=true')).toBe('keep_without_split');
    expect(errorCategory('elysium_tx is not split by day: the database server is older than Postgres 14')).toBe('server_too_old');
    expect(errorCategory('Elysium ingest: window exceeded the page cap')).toBe('page_cap');
    expect(errorCategory('something else at 10.0.0.3')).toBe('error');
    expect(errorCategory(null)).toBeNull();
  });
});
