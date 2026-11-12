import { Prisma } from '../../../prisma-historical/generated/client';

/**
 * SQL shared by the readers of what stands in for old transactions (see
 * elysium-retention.util and ElysiumFactsRepository).
 */

/**
 * The first instant after the UTC days folded into the history facts
 * (elysium_target_seen, elysium_address_method): what a reader adds from
 * elysium_tx starts there. '-infinity' while nothing is folded: the reader
 * then takes everything from elysium_tx, as it did before the facts existed.
 *
 * Used inside the statement that reads the facts themselves, never read apart
 * and passed in: a fold moves the tables and this day in one transaction, and
 * a statement sees both as of one instant.
 */
export const AFTER_HISTORY_FACTS = Prisma.sql`COALESCE(
  (SELECT ((f.through_day + 1)::timestamp AT TIME ZONE 'UTC') FROM elysium_fact_state f WHERE f.fact = 'history'),
  '-infinity'::timestamptz)`;

/**
 * Who sent the transaction of a swap (alias s): the sender copied onto it, else the one of
 * its transaction in elysium_tx, else the address the pool names (usually a router).
 *
 * The lookup is a subquery inside COALESCE on purpose, not a join: it only runs for a row
 * that has no sender copied, one row at a time, and it names the hash together with the block
 * time (a swap and its transaction are in the same block), so that it opens the one day of
 * elysium_tx the transaction is in, whatever plan the rest of the statement gets.
 */
export const SWAP_SENDER = Prisma.sql`COALESCE(s.tx_from,
  (SELECT t.from_addr FROM elysium_tx t WHERE t.tx_hash = s.tx_hash AND t.block_time = s.block_time LIMIT 1),
  s.sender)`;

/** Who made a launchpad trade (alias tr): the trader its event names, else the sender of its transaction, the same way. */
export const TRADE_TRADER = Prisma.sql`COALESCE(tr.trader, tr.tx_from,
  (SELECT t.from_addr FROM elysium_tx t WHERE t.tx_hash = tr.tx_hash AND t.block_time = tr.block_time LIMIT 1))`;

/** Who created a launch (alias l): the creator its event names, else the sender of its transaction, the same way. */
export const LAUNCH_CREATOR = Prisma.sql`COALESCE(l.creator, l.tx_from,
  (SELECT t.from_addr FROM elysium_tx t WHERE t.tx_hash = l.tx_hash AND t.block_time = l.created_at LIMIT 1))`;

/** LAUNCH_CREATOR for the statements that are plain text. */
export const LAUNCH_CREATOR_SQL = `COALESCE(l.creator, l.tx_from,
  (SELECT t.from_addr FROM elysium_tx t WHERE t.tx_hash = l.tx_hash AND t.block_time = l.created_at LIMIT 1))`;
