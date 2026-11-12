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
 * The transaction of a swap (alias s) that has no sender copied yet, as alias
 * t. A swap and its transaction are in the same block and carry the same
 * time: named with the hash, it keeps the lookup inside one day of elysium_tx.
 * Read the sender as COALESCE(s.tx_from, t.from_addr, ...).
 */
export const SWAP_SENDER_JOIN = Prisma.sql`LEFT JOIN elysium_tx t
  ON s.tx_from IS NULL AND t.tx_hash = s.tx_hash AND t.block_time = s.block_time`;

/** The same for a launchpad trade (alias tr) that names no trader, as alias t: COALESCE(tr.trader, tr.tx_from, t.from_addr). */
export const TRADE_SENDER_JOIN = Prisma.sql`LEFT JOIN elysium_tx t
  ON tr.trader IS NULL AND tr.tx_from IS NULL AND t.tx_hash = tr.tx_hash AND t.block_time = tr.block_time`;

/** The same for a launch (alias l) that names no creator, as alias tx: COALESCE(l.creator, l.tx_from, tx.from_addr). */
export const LAUNCH_SENDER_JOIN = Prisma.sql`LEFT JOIN elysium_tx tx
  ON l.creator IS NULL AND l.tx_from IS NULL AND tx.tx_hash = l.tx_hash AND tx.block_time = l.created_at`;
