/**
 * Points the historical database of the code under test at the test database, and refuses to
 * run anywhere else: these tests empty the Elysium tables.
 */
const url = process.env.TEST_HISTORICAL_DATABASE_URL;
if (!url) {
  throw new Error('TEST_HISTORICAL_DATABASE_URL is not set: the database tests need a Postgres database of their own (see docs/ELYSIUM_RUNBOOK.md)');
}
const database = new URL(url).pathname.replace(/^\//, '');
if (!/(test|scratch)/i.test(database)) {
  throw new Error(`Refusing to run the database tests on "${database}": its name must contain "test" or "scratch" (they truncate tables)`);
}
process.env.HISTORICAL_DATABASE_URL = url;
process.env.NODE_ENV = 'test';
