/**
 * The tests that run the Elysium SQL on a real Postgres (tests/db, `npm run test:db`). The other
 * tests mock the database, so until these nothing ran a statement before production did. They
 * need TEST_HISTORICAL_DATABASE_URL: a database of their own, migrated, that they empty as they go.
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/tests/db/**/*.dbtest.ts'],
  setupFiles: ['<rootDir>/tests/db/setup.ts'],
  // The generated Prisma clients run as they are. Recompiled by the .js transform of the base
  // config, the client's own error classes break ("Must call super constructor"), and a row the
  // database refuses then surfaces as that, with no SQLSTATE to read.
  transformIgnorePatterns: [...base.transformIgnorePatterns, '/generated/'],
  // One database for all of them: one file at a time.
  maxWorkers: 1,
  testTimeout: 120_000,
};
