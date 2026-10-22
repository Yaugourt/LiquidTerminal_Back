module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
    // sanitize-html >= 2.17.7 pulls ESM-only htmlparser2 12 / entities 8 / dom*.
    // Jest compiles them to CJS; the runtime loads them via require(esm) (Node >= 22.12).
    '^.+\\.m?js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs', esModuleInterop: true } }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(sanitize-html|htmlparser2|entities|dom-serializer|domhandler|domutils|domelementtype)/)'],
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