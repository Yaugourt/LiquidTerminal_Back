/**
 * Points the historical database of the code under test at the test database, and refuses to
 * run anywhere else: these tests empty the Elysium tables.
 *
 * Two conditions, both needed: the database's name says it is one ("test" or "scratch" as a
 * word of its own: `elysium_test`, `lt_step8_scratch`; not `latest` nor `contest`), and it is on
 * this machine. A database elsewhere is only accepted with TEST_DB_ALLOW_REMOTE=1.
 */
const url = process.env.TEST_HISTORICAL_DATABASE_URL;
if (!url) {
  throw new Error('TEST_HISTORICAL_DATABASE_URL is not set: the database tests need a Postgres database of their own (see docs/ELYSIUM_RUNBOOK.md)');
}
const target = new URL(url);
const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (!/(^|[_-])(test|scratch)([_-]|$)/i.test(database)) {
  throw new Error(`Refusing to run the database tests on "${database}": its name must hold "test" or "scratch" as a word (they truncate tables)`);
}
const local = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'].includes(target.hostname);
if (!local && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
  throw new Error('Refusing to run the database tests on a database that is not on this machine (set TEST_DB_ALLOW_REMOTE=1 to allow it)');
}
process.env.HISTORICAL_DATABASE_URL = url;
process.env.NODE_ENV = 'test';
