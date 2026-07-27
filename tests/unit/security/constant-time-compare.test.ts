import { matchesAnyKey } from '../../../src/utils/constant-time-compare';

describe('matchesAnyKey', () => {
  const keys = ['primary-key-abcdefghijklmnop', 'secondary-key-qrstuvwxyz012345'];

  it('accepts an exact match against any valid key', () => {
    expect(matchesAnyKey('primary-key-abcdefghijklmnop', keys)).toBe(true);
    expect(matchesAnyKey('secondary-key-qrstuvwxyz012345', keys)).toBe(true);
  });

  it('rejects a wrong key', () => {
    expect(matchesAnyKey('primary-key-abcdefghijklmnoX', keys)).toBe(false);
    expect(matchesAnyKey('totally-different', keys)).toBe(false);
  });

  it('rejects on empty input or empty key set', () => {
    expect(matchesAnyKey('', keys)).toBe(false);
    expect(matchesAnyKey('anything', [])).toBe(false);
  });

  it('is not fooled by a prefix (length differences do not short-circuit)', () => {
    expect(matchesAnyKey('primary-key', keys)).toBe(false);
    expect(matchesAnyKey('primary-key-abcdefghijklmnopEXTRA', keys)).toBe(false);
  });
});
