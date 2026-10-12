import {
  addDays,
  aggregateCsv,
  daysBetween,
  fileUrl,
  lastPublishedDay,
  userKey,
} from '../../../../src/services/builders/builder-growth.util';

describe('builder-growth.util', () => {
  it('waits for the next-day publication before trusting a day', () => {
    expect(lastPublishedDay(new Date('2026-10-11T05:00:00Z'))).toBe('2026-10-10');
    expect(lastPublishedDay(new Date('2026-10-11T02:00:00Z'))).toBe('2026-10-09');
  });

  it('walks UTC days across month and year ends', () => {
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(daysBetween('2025-02-27', '2025-03-01')).toEqual(['2025-02-27', '2025-02-28', '2025-03-01']);
    expect(daysBetween('2025-03-02', '2025-03-01')).toEqual([]);
  });

  it('builds the public file url with a lowercase address and a compact date', () => {
    expect(fileUrl('0xB84168CF3BE63C6B8DAD05FF5D755E97432FF80B', '2026-10-09')).toBe(
      'https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/0xb84168cf3be63c6b8dad05ff5d755e97432ff80b/20261009.csv.lz4'
    );
  });

  it('keys a user on the first 8 bytes of the address, case-insensitively', () => {
    expect(userKey('0xFFFFFFFFFFFFFFFF0000')).toBe('-1');
    expect(userKey('0x0000000000000001aa')).toBe('1');
    expect(userKey('0xAbCdEf0123456789')).toBe(userKey('0xabcdef0123456789'));
  });

  it('sums fees and volume and counts distinct users', () => {
    const csv = [
      'time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee',
      '2026-10-09T00:00:12Z,0x8638fa925e9662e9cf3119176e47563256c049ab,SOL,Bid,100,2,true,Na,Ioc,false,0xe3,0,0,0.5',
      '2026-10-09T00:00:18Z,0x8638fa925e9662e9cf3119176e47563256c049ab,SOL,Bid,50,1,true,Na,Ioc,false,0xa6,0,0,0.25',
      '2026-10-09T00:01:00Z,0x1111111111111111111111111111111111111111,BTC,Ask,10,3,true,Na,Ioc,false,0xa6,0,0,0.1',
      '',
    ].join('\n');
    const agg = aggregateCsv(csv);
    expect(agg.fills).toBe(3);
    expect(agg.fees).toBeCloseTo(0.85);
    expect(agg.volume).toBeCloseTo(280);
    expect(agg.users).toHaveLength(2);
  });

  it('counts zero fees on the first files, which have no builder_fee column', () => {
    const agg = aggregateCsv('time,user,coin,side,px,sz\n2024-10-27T10:00:00Z,0x8638fa925e9662e9cf3119176e47563256c049ab,ETH,Bid,10,2\n');
    expect(agg).toMatchObject({ fills: 1, fees: 0, volume: 20 });
    expect(agg.users).toHaveLength(1);
  });

  it('refuses a file whose header changed', () => {
    expect(() => aggregateCsv('time,trader,px\n')).toThrow(/header/);
  });
});
