import { HypeDexerInfoClient, sortLedgerAscending, viaInfoProxy } from '../../clients/hypedexer/rest/info/info.client';
import { LedgerUpdate, RY_INTEREST_ADDRESS } from './reserve-yield.ledger';

const HL_INFO_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
const TIMEOUT_MS = 10_000;

async function readFromHyperliquid(startTime: number): Promise<LedgerUpdate[]> {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'userNonFundingLedgerUpdates', user: RY_INTEREST_ADDRESS, startTime }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`info userNonFundingLedgerUpdates ${res.status}`);
  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) throw new Error('unexpected ledger payload');
  return rows as LedgerUpdate[];
}

/**
 * The USDC interest address ledger from `startTime`, oldest first by (time,
 * hash) whichever source answers (HypeDexer lists newest first, Hyperliquid
 * oldest first), so the cursor logic of the readers sees one order. Read
 * through HypeDexer's /info (2 + ceil(rows / 10) credits, no Hyperliquid
 * weight), from Hyperliquid (weight 20) when the proxy fails.
 */
export async function readReserveLedger(startTime: number): Promise<LedgerUpdate[]> {
  const rows = await viaInfoProxy<LedgerUpdate[]>(
    'userNonFundingLedgerUpdates',
    () => HypeDexerInfoClient.getInstance().userNonFundingLedgerUpdates(RY_INTEREST_ADDRESS, startTime),
    () => readFromHyperliquid(startTime)
  );
  return sortLedgerAscending(rows);
}
