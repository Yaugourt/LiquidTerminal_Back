import { prismaHistorical } from '../../src/core/prisma.historical.service';

export const q = <T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> =>
  prismaHistorical.$queryRawUnsafe<T[]>(sql, ...args);
export const x = (sql: string, ...args: unknown[]): Promise<number> => prismaHistorical.$executeRawUnsafe(sql, ...args);

/** Every Elysium table the ingestion writes, emptied. */
export const wipe = (): Promise<number> =>
  x(`TRUNCATE elysium_tx, elysium_tx_live, elysium_contract, elysium_address, elysium_address_day, elysium_day_rollup,
     elysium_call_day, elysium_caller_day, elysium_caller_set, elysium_method_sender_day, elysium_day_check,
     elysium_dex_pool, elysium_dex_swap, elysium_launch, elysium_launch_trade, elysium_ingest_reject,
     elysium_bridge_transfer, elysium_token, elysium_token_stat, elysium_ingest_state,
     elysium_hour_rollup, elysium_call_hour, elysium_target_window, elysium_deployer_window, elysium_window_state`);

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
