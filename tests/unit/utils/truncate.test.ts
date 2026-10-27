import { truncateToLength } from '../../../src/utils/truncate';

describe('truncateToLength', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateToLength('abc', 3)).toBe('abc');
    expect(truncateToLength('', 0)).toBe('');
  });

  it('cuts plain text at the limit', () => {
    expect(truncateToLength('abcdef', 4)).toBe('abcd');
  });

  it('never splits a surrogate pair', () => {
    expect(truncateToLength('ab😀cd', 3)).toBe('ab'); // the emoji spans units 2-3
    expect(truncateToLength('ab😀cd', 4)).toBe('ab😀');
    expect(truncateToLength('😀😀', 3)).toBe('😀');
    expect(truncateToLength('😀', 1)).toBe('');
  });

  it('keeps UTF-16 length within the limit', () => {
    const text = '😀a😀b😀c';
    for (let max = 0; max <= text.length; max++) {
      expect(truncateToLength(text, max).length).toBeLessThanOrEqual(max);
    }
  });
});
