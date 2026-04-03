module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/\\.agents/'],
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/src/**/*.test.ts'],
  /** Integration tests pull Express + middleware with timers; avoid hanging CI */
  forceExit: true,
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
}; 