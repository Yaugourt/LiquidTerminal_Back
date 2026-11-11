/**
 * The trade decoders used to be handed every launch (420,000 rows, read twice per 30 s tick).
 * They now get the launches matching the keys their logs name (launchMarketCandidates, then
 * token / curve / pool = ANY(keys) in the database). On the real testnet logs of the fixtures:
 * decoding with that subset gives exactly what decoding with every launch gives.
 */
import {
  decodeGraduation,
  decodeLaunch,
  decodeLaunchTrade,
  graduationKey,
  launchGraduationKeys,
  launchMarketCandidates,
  launchMarketKeys,
  type LaunchMarket,
  type LaunchRow,
} from '../../../src/services/elysium/elysium-launchpad.util';
import fixtures from './fixtures/launchpads-2026-11-02.json';

const logs = Object.values(fixtures as Record<string, Record<string, unknown>>);
const launches = logs.map(decodeLaunch).filter((l): l is LaunchRow => l !== null);

const mapOf = (rows: LaunchRow[]): Map<string, LaunchMarket> => {
  const m = new Map<string, LaunchMarket>();
  for (const l of rows) for (const k of launchMarketKeys(l)) m.set(k, { token: l.token, launchpad: l.launchpad, quote: l.quote });
  return m;
};
/** What findLaunchMarkets returns for a set of keys. */
const found = (keys: string[]): LaunchRow[] => {
  const wanted = new Set(keys);
  return launches.filter((l) => wanted.has(l.token) || (l.curve !== null && wanted.has(l.curve)) || (l.pool !== null && wanted.has(l.pool)));
};

describe('launch markets for a page of logs', () => {
  const every = mapOf(launches);

  it('has fixtures that exercise the decoders', () => {
    expect(launches.length).toBeGreaterThanOrEqual(4);
    expect(logs.filter((l) => decodeLaunchTrade(l, every) !== null).length).toBeGreaterThanOrEqual(6);
  });

  it('decodes every trade the same from the launches its log names as from all of them', () => {
    for (const l of logs) {
      const subset = mapOf(found(launchMarketCandidates([l])));
      expect(decodeLaunchTrade(l, subset)).toEqual(decodeLaunchTrade(l, every));
    }
  });

  it('decodes a whole page the same', () => {
    const subset = mapOf(found(launchMarketCandidates(logs)));
    expect(logs.map((l) => decodeLaunchTrade(l, subset))).toEqual(logs.map((l) => decodeLaunchTrade(l, every)));
  });

  it('finds the launch of every graduation among the launches its log names', () => {
    // It used to compare two lookups by TRADE key, which both missed every Kiln graduation.
    const pads = new Set<string>();
    for (const l of logs) {
      const g = decodeGraduation(l);
      if (!g) continue;
      const key = graduationKey(g);
      const named = found(launchMarketCandidates([l]));
      const launch = launches.find((x) => x.token === g.token || (g.curve !== null && x.curve === g.curve));
      if (!launch) continue;
      pads.add(launch.launchpad);
      expect(key).not.toBeNull();
      expect(named.flatMap(launchGraduationKeys)).toContain(key);
    }
    expect([...pads]).toContain('Kiln');
  });

  it('graduates a token only under its own pad, and a curve launch only by its curve', () => {
    const kiln = launches.find((l) => l.launchpad === 'Kiln') as LaunchRow;
    const graduation = logs.map(decodeGraduation).find((g) => g?.launchpad === 'Kiln');
    expect(graduation).toBeDefined();
    expect(launchGraduationKeys(kiln)).toEqual([`Kiln:${kiln.token}`]);
    expect(graduationKey(graduation!)).toBe(`Kiln:${kiln.token}`);
    // The same token address under another pad, or a curve launch named by its token: no match.
    expect(launchGraduationKeys({ ...kiln, launchpad: 'Neuriio' })).not.toContain(graduationKey(graduation!));
    expect(launchGraduationKeys({ token: kiln.token, curve: '0x' + 'cc'.repeat(20), launchpad: 'CorePad' })).toEqual(['0x' + 'cc'.repeat(20)]);
    expect(launchGraduationKeys({ token: kiln.token, curve: null, launchpad: 'BunnyPad' })).toEqual([]);
    expect(graduationKey({ curve: '0x' + 'cc'.repeat(20), token: null, launchpad: null, pool: null, graduated_at: '' })).toBe('0x' + 'cc'.repeat(20));
    expect(graduationKey({ curve: null, token: kiln.token, launchpad: null, pool: null, graduated_at: '' })).toBeNull();
  });

  it('names the emitter and the first indexed argument, as an address and as 32 bytes', () => {
    const word = '0x' + '00'.repeat(12) + 'AB'.repeat(20);
    const keys = launchMarketCandidates([
      { block_time: '2026-11-02T10:00:00', block_number: 1, log_index: 0, tx_hash: '0x' + '11'.repeat(32), address: '0x' + 'CD'.repeat(20), topic0: '0x' + '22'.repeat(32), topic1: word, topic2: '', topic3: '', data: '0x' },
      null,
      { nonsense: true },
    ]);
    expect(keys.sort()).toEqual(['0x' + 'ab'.repeat(20), '0x' + 'cd'.repeat(20), word.toLowerCase()].sort());
    expect(launchMarketCandidates([])).toEqual([]);
  });
});
