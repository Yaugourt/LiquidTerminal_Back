import { positiveIntEnv } from '../../../src/utils/env';

describe('positiveIntEnv', () => {
  const NAME = 'TEST_POSITIVE_INT_ENV';
  afterEach(() => {
    delete process.env[NAME];
  });
  const read = (value?: string): number => {
    if (value === undefined) delete process.env[NAME];
    else process.env[NAME] = value;
    return positiveIntEnv(NAME, 7);
  };

  it('reads a plain positive integer, spaces around it or not', () => {
    expect(read('60000')).toBe(60000);
    expect(read(' 15 ')).toBe(15);
  });

  it('falls back when unset, empty, zero or negative', () => {
    expect(read()).toBe(7);
    expect(read('')).toBe(7);
    expect(read('0')).toBe(7);
    expect(read('-5')).toBe(7);
  });

  it('falls back on a value that only starts like a number: 60s was read as 60, 1e5 as 1', () => {
    expect(read('60s')).toBe(7);
    expect(read('1e5')).toBe(7);
    expect(read('1.5')).toBe(7);
    expect(read('10 000')).toBe(7);
    expect(read('abc')).toBe(7);
  });
});
