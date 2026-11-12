import { prismaHistorical } from '../../src/core/prisma.historical.service';
import { ElysiumPartitionRepository } from '../../src/repositories/prisma/prisma.elysium-partition.repository';

export const q = <T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> =>
  prismaHistorical.$queryRawUnsafe<T[]>(sql, ...args);
export const x = (sql: string, ...args: unknown[]): Promise<number> => prismaHistorical.$executeRawUnsafe(sql, ...args);

const DAY_MS = 86_400_000;
/** The split of the test database starts this many days before today: the fixtures' days each have their table. */
export const TEST_SPLIT_DAYS_BACK = 75;
let layout: Promise<void> | null = null;

/**
 * elysium_tx laid out as production has it: split by day, with "everything before" as its
 * first part and a table for each day from 75 days ago to the days ahead. Done once per test
 * process with the code's own steps (a database fresh from the migrations has one plain table).
 */
export function splitLayout(): Promise<void> {
  layout ??= (async () => {
    const parts = ElysiumPartitionRepository.getInstance();
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    let now = await parts.layout();
    if (!now.partitioned) {
      const cut = today - TEST_SPLIT_DAYS_BACK * DAY_MS;
      await x(`DELETE FROM elysium_tx`);
      if ((await parts.prepare(cut)) !== 'done') throw new Error('test layout: elysium_tx is busy');
      await parts.validate();
      if ((await parts.split(cut, [])) !== 'done') throw new Error('test layout: elysium_tx could not be split');
      now = await parts.layout();
    }
    const first = Math.min(...now.parts.map((p) => p.fromMs ?? p.toMs));
    for (let day = first; day <= today + 3 * DAY_MS; day += DAY_MS) {
      if (now.parts.some((p) => (p.fromMs === null || p.fromMs <= day) && day < p.toMs)) continue;
      await parts.ensureDay(new Date(day).toISOString().slice(0, 10));
    }
    parts.forgetFloor();
  })();
  return layout;
}

/** Forgets that the layout was made (a test changed it on purpose): the next wipe makes it again. */
export function forgetSplitLayout(): void {
  layout = null;
}

/**
 * Back to one plain elysium_tx, as the migrations make it: the day tables dropped, the first
 * part renamed back. Test-only (the table is emptied first): it is also what undoing the split
 * comes to while no day table holds a row.
 */
export async function unsplit(): Promise<void> {
  const parts = ElysiumPartitionRepository.getInstance();
  const now = await parts.layout();
  if (now.partitioned) {
    const legacy = now.parts.find((p) => p.fromMs === null);
    const days = now.parts.filter((p) => p.fromMs !== null).map((p) => `"${p.name}"`);
    // In one statement: eighty tables dropped one by one are eighty commits.
    if (days.length > 0) await x(`DROP TABLE ${days.join(', ')}`);
    if (legacy) {
      await x(`ALTER TABLE elysium_tx DETACH PARTITION "${legacy.name}"`);
      await x(`DROP TABLE elysium_tx`);
      await x(`ALTER TABLE "${legacy.name}" RENAME TO elysium_tx`);
      await x(`DELETE FROM elysium_tx`);
    } else {
      // The first part was dropped by a purge test: the plain table is made again from the parent's columns.
      await x(`CREATE TABLE elysium_tx_plain (LIKE elysium_tx INCLUDING DEFAULTS INCLUDING STORAGE)`);
      await x(`DROP TABLE elysium_tx`);
      await x(`ALTER TABLE elysium_tx_plain RENAME TO elysium_tx`);
      await x(`ALTER TABLE elysium_tx ADD CONSTRAINT elysium_tx_pkey PRIMARY KEY (tx_hash)`);
      await x(`CREATE INDEX elysium_tx_block_time_idx ON elysium_tx (block_time)`);
      await x(`CREATE INDEX elysium_tx_to_addr_block_time_idx ON elysium_tx (to_addr, block_time)`);
      await x(`CREATE INDEX elysium_tx_from_addr_block_time_idx ON elysium_tx (from_addr, block_time)`);
    }
  }
  await x(`ALTER TABLE elysium_tx DROP CONSTRAINT IF EXISTS elysium_tx_split_bound`);
  parts.forgetFloor();
  forgetSplitLayout();
}

/** Every Elysium table the ingestion writes, emptied (elysium_tx split by day first, if it is not). */
export const wipe = async (): Promise<number> => {
  await splitLayout();
  return wipeTables();
};

/**
 * The same without touching the layout of elysium_tx. Its rows are deleted, not truncated:
 * truncating a table split in eighty day tables rewrites each of them and their indexes (5 s).
 */
export const wipeTables = async (): Promise<number> => {
  await x(`DELETE FROM elysium_tx`);
  return wipeOthers();
};

const wipeOthers = (): Promise<number> =>
  x(`TRUNCATE elysium_tx_live, elysium_contract, elysium_address, elysium_address_day, elysium_day_rollup,
     elysium_call_day, elysium_caller_day, elysium_caller_set, elysium_method_sender_day, elysium_day_check,
     elysium_dex_pool, elysium_dex_swap, elysium_launch, elysium_launch_trade, elysium_ingest_reject,
     elysium_bridge_transfer, elysium_token, elysium_token_stat, elysium_ingest_state,
     elysium_hour_rollup, elysium_call_hour, elysium_target_window, elysium_deployer_window, elysium_window_state,
     elysium_fact_state, elysium_target_seen, elysium_address_method, elysium_project_contract, elysium_project_wallet`);

export const H = (n: number): string => '0x' + n.toString(16).padStart(64, '0');
export const A = (n: number): string => '0x' + n.toString(16).padStart(40, '0');

export interface TxFixture {
  tx_hash: string;
  block_number: string;
  block_time: string;
  from_addr: string;
  to_addr: string | null;
  contract_address: string | null;
  method_id: string | null;
  tx_type: string | null;
  gas_used: string;
  fee_wei: string;
  success: boolean;
  is_spam: boolean;
}

export async function disconnect(): Promise<void> {
  await prismaHistorical.$disconnect();
}
