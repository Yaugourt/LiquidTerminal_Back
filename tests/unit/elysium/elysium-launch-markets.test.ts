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

  it('knows the market of every graduation the full set knows', () => {
    let seen = 0;
    for (const l of logs) {
      const g = decodeGraduation(l);
      const key = g?.curve ?? g?.token;
      if (!key) continue;
      seen += 1;
      expect(mapOf(found(launchMarketCandidates([l]))).has(key)).toBe(every.has(key));
    }
    expect(seen).toBeGreaterThan(0);
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
