import {
  dedupeBy,
  ELYSIUM_GENESIS,
  HOUR_MS,
  normalizeBridgeTransfer,
  normalizeToken,
  normalizeTx,
  parseUpstreamTime,
  planWindow,
  scaleRawAmount,
  toUpstreamTime,
} from '../../../src/services/elysium/elysium-ingest.util';

const base = {
  genesis: ELYSIUM_GENESIS,
  stepMs: HOUR_MS,
  overlapMs: 120_000,
  settleMs: 15_000,
};

describe('planWindow', () => {
  describe('ceiling (what the provider has indexed)', () => {
    const now = new Date('2026-09-20T00:01:00Z');
    const cursor = new Date('2026-09-20T00:00:30Z');
    const live = { ...base, overlapMs: 20_000, cursor, backfillDone: true, now };

    it('does not hold a window back when the provider is ahead of the settle horizon', () => {
      const w = planWindow({ ...live, ceiling: new Date('2026-09-20T00:00:52Z') });
      expect(w?.end).toEqual(new Date('2026-09-20T00:00:45Z'));
      expect(w?.caughtUp).toBe(true);
      // Unknown head: the clock alone bounds the window.
      expect(planWindow({ ...live, ceiling: null })?.end).toEqual(new Date('2026-09-20T00:00:45Z'));
      expect(planWindow(live)?.end).toEqual(new Date('2026-09-20T00:00:45Z'));
    });

    it('ends the window at the ceiling when the provider is behind', () => {
      const w = planWindow({ ...live, ceiling: new Date('2026-09-20T00:00:38Z') });
      expect(w).toEqual({ start: new Date('2026-09-20T00:00:10Z'), end: new Date('2026-09-20T00:00:38Z'), caughtUp: true });
    });

    it('reads nothing while the ceiling has not passed the cursor, so the cursor never runs ahead', () => {
      expect(planWindow({ ...live, ceiling: cursor })).toBeNull();
      expect(planWindow({ ...live, ceiling: new Date('2026-09-19T00:00:00Z') })).toBeNull();
    });

    it('bounds a backfill window too', () => {
      const w = planWindow({ ...base, cursor: new Date('2026-09-12T00:00:00Z'), backfillDone: false, now, ceiling: new Date('2026-09-12T00:20:00Z') });
      expect(w?.end).toEqual(new Date('2026-09-12T00:20:00Z'));
      expect(w?.caughtUp).toBe(true);
    });
  });

  it('starts at genesis without overlap when the stream never ran', () => {
    const now = new Date('2026-09-20T00:00:00Z');
    const w = planWindow({ ...base, cursor: null, backfillDone: false, now });
    expect(w).toEqual({
      start: ELYSIUM_GENESIS,
      end: new Date(ELYSIUM_GENESIS.getTime() + HOUR_MS),
      caughtUp: false,
    });
  });

  it('walks backfill forward from the cursor in step-sized windows', () => {
    const cursor = new Date('2026-09-12T00:00:00Z');
    const w = planWindow({ ...base, cursor, backfillDone: false, now: new Date('2026-09-20T00:00:00Z') });
    expect(w?.start).toEqual(cursor);
    expect(w?.end).toEqual(new Date('2026-09-12T01:00:00Z'));
    expect(w?.caughtUp).toBe(false);
  });

  it('clamps the last backfill window to now - settle and reports caughtUp', () => {
    const now = new Date('2026-09-20T00:30:00Z');
    const w = planWindow({ ...base, cursor: new Date('2026-09-20T00:00:00Z'), backfillDone: false, now });
    expect(w?.end).toEqual(new Date(now.getTime() - 15_000));
    expect(w?.caughtUp).toBe(true);
  });

  it('re-reads the overlap before the cursor in live mode', () => {
    const now = new Date('2026-09-20T00:01:00Z');
    const cursor = new Date('2026-09-20T00:00:30Z');
    const w = planWindow({ ...base, cursor, backfillDone: true, now });
    expect(w?.start).toEqual(new Date(cursor.getTime() - 120_000));
    expect(w?.end).toEqual(new Date(now.getTime() - 15_000));
    expect(w?.caughtUp).toBe(true);
  });

  it('caps a live window after downtime to one step past the cursor', () => {
    const cursor = new Date('2026-09-20T00:00:00Z');
    const w = planWindow({ ...base, cursor, backfillDone: true, now: new Date('2026-09-20T05:00:00Z') });
    expect(w?.end).toEqual(new Date('2026-09-20T01:00:00Z'));
    expect(w?.caughtUp).toBe(false);
  });

  it('never starts before genesis in live mode', () => {
    const w = planWindow({ ...base, cursor: ELYSIUM_GENESIS, backfillDone: true, now: new Date('2026-09-12T00:00:00Z') });
    expect(w?.start).toEqual(ELYSIUM_GENESIS);
  });

  it('returns null when the cursor is at or past the horizon', () => {
    const now = new Date('2026-09-20T00:00:00Z');
    expect(planWindow({ ...base, cursor: new Date(now.getTime() - 10_000), backfillDone: true, now })).toBeNull();
  });
});

describe('upstream time helpers', () => {
  it('treats zone-less upstream timestamps as UTC', () => {
    expect(parseUpstreamTime('2026-09-28T08:00:10')?.toISOString()).toBe('2026-09-28T08:00:10.000Z');
    expect(parseUpstreamTime('2026-09-28T07:24:11.782000')?.toISOString()).toBe('2026-09-28T07:24:11.782Z');
    expect(parseUpstreamTime('2026-09-28T08:00:10Z')?.toISOString()).toBe('2026-09-28T08:00:10.000Z');
    expect(parseUpstreamTime(null)).toBeNull();
    expect(parseUpstreamTime('')).toBeNull();
    expect(parseUpstreamTime('garbage')).toBeNull();
  });

  it('formats filters without zone or millis', () => {
    expect(toUpstreamTime(new Date('2026-09-28T08:00:10.999Z'))).toBe('2026-09-28T08:00:10');
  });
});

describe('scaleRawAmount', () => {
  it('scales exactly without float rounding', () => {
    expect(scaleRawAmount('1000000000000000000', 18)).toBe('1');
    expect(scaleRawAmount('300871261691140603774025', 18)).toBe('300871.261691140603774025');
    expect(scaleRawAmount('1500000', 6)).toBe('1.5');
    expect(scaleRawAmount('5', 18)).toBe('0.000000000000000005');
    expect(scaleRawAmount('0', 18)).toBe('0');
    expect(scaleRawAmount('42', 0)).toBe('42');
    expect(scaleRawAmount('42', null)).toBe('42');
  });

  it('rejects non-integer raw values', () => {
    expect(scaleRawAmount('', 18)).toBeNull();
    expect(scaleRawAmount('1.5', 18)).toBeNull();
    expect(scaleRawAmount(null, 18)).toBeNull();
  });
});

describe('normalizeTx', () => {
  const raw = {
    block_time: '2026-09-28T08:00:08',
    block_number: 569747,
    tx_hash: '0x60D980F101F09113190CF94022B623D76E1CCA375E1FB6B2CF415B04CEACD908',
    from_addr: '0x308751b6e4e23235526a8ddae8bcf52232fc8c0e',
    to_addr: '',
    contract_address: '0x6d68e8652751714e953b4e421eba4a6533109d73',
    method_id: '0x60806040',
    tx_type: '0x2',
    gas_used: 836859,
    effective_gas_price: 10000000,
    success: 1,
    is_system: 0,
    is_spam: 0,
  };

  it('maps a contract creation with exact fee and null empty strings', () => {
    expect(normalizeTx(raw)).toEqual({
      tx_hash: raw.tx_hash.toLowerCase(),
      block_number: '569747',
      block_time: '2026-09-28T08:00:08.000Z',
      from_addr: raw.from_addr,
      to_addr: null,
      contract_address: raw.contract_address,
      method_id: '0x60806040',
      tx_type: '0x2',
      gas_used: '836859',
      fee_wei: '8368590000000',
      success: true,
      is_spam: false,
    });
  });

  it('drops system txs and malformed rows', () => {
    expect(normalizeTx({ ...raw, is_system: 1 })).toBeNull();
    expect(normalizeTx({ ...raw, tx_hash: '' })).toBeNull();
    expect(normalizeTx({ ...raw, block_time: null })).toBeNull();
    expect(normalizeTx(null)).toBeNull();
  });

  it('keeps spam flagged', () => {
    expect(normalizeTx({ ...raw, is_spam: 1 })?.is_spam).toBe(true);
  });
});

describe('normalizeBridgeTransfer / normalizeToken / dedupeBy', () => {
  it('maps a completed deposit', () => {
    const row = normalizeBridgeTransfer({
      transfer_id: 'd:54652',
      direction: 'deposit',
      asset: 'token',
      route: 'canonical',
      status: 'completed',
      symbol: 'MACHA',
      decimals: 18,
      from_addr: '0xBE5BF4DA2886CD8C60DE03708BD410D10684E774',
      to_addr: '0xbe5bf4da2886cd8c60de03708bd410d10684e774',
      amount_raw: '1000000000000000000',
      amount: 1.0,
      l1_tx_hash: '0x76e6',
      l2_tx_hash: '',
      initiated_time: '2026-09-28T01:25:50',
      completed_time: '2026-09-28T01:27:04',
      duration_s: 74.0,
    });
    expect(row).toMatchObject({
      transfer_id: 'd:54652',
      amount: '1',
      from_addr: '0xbe5bf4da2886cd8c60de03708bd410d10684e774',
      l2_tx_hash: null,
      initiated_at: '2026-09-28T01:25:50.000Z',
      completed_at: '2026-09-28T01:27:04.000Z',
      duration_s: 74,
    });
    expect(normalizeBridgeTransfer({ transfer_id: 'w:1', initiated_time: null })).toBeNull();
  });

  it('maps a token', () => {
    expect(
      normalizeToken({
        address: '0x7AE29BE60A29425DABC75E361875F1DD21C160A7',
        standard: 'erc20',
        name: 'Chappie',
        symbol: 'Chap',
        decimals: 18,
        origin: 'native',
        first_seen: '2026-09-25T21:34:58',
        transfer_count: 6104,
      })
    ).toEqual({
      address: '0x7ae29be60a29425dabc75e361875f1dd21c160a7',
      standard: 'erc20',
      name: 'Chappie',
      symbol: 'Chap',
      decimals: 18,
      origin: 'native',
      first_seen: '2026-09-25T21:34:58.000Z',
      transfer_count: '6104',
    });
  });

  it('dedupes by key keeping the last row', () => {
    expect(dedupeBy([{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }], (r) => r.k)).toEqual([
      { k: 'a', v: 3 },
      { k: 'b', v: 2 },
    ]);
  });
});
