import {
  HypeDexerInfoClient,
  INFO_LEDGER_MAX_ROWS,
  sortLedgerAscending,
  viaInfoProxy,
} from '../../clients/hypedexer/rest/info/info.client';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { hyperliquidWeightMeter } from '../../utils/hyperliquid-weight-meter';
import { LedgerUpdate, RY_INTEREST_ADDRESS } from './reserve-yield.ledger';

const HL_INFO_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
const TIMEOUT_MS = 10_000;

async function readFromHyperliquid(startTime: number): Promise<LedgerUpdate[]> {
  hyperliquidWeightMeter.record('userNonFundingLedgerUpdates');
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
 *
 * HypeDexer answers 500 rows at most and keeps the newest, so an answer of 500
 * rows or more may have lost the oldest ones: that call is read from
 * Hyperliquid, which returns the oldest rows from `startTime`.
 */
export async function readReserveLedger(startTime: number): Promise<LedgerUpdate[]> {
  const viaProxy = await viaInfoProxy<LedgerUpdate[] | null>(
    'userNonFundingLedgerUpdates',
    async () => {
      const rows = await HypeDexerInfoClient.getInstance().userNonFundingLedgerUpdates(RY_INTEREST_ADDRESS, startTime);
      return rows.length >= INFO_LEDGER_MAX_ROWS ? null : rows;
    },
    () => readFromHyperliquid(startTime)
  );
  if (viaProxy) return sortLedgerAscending(viaProxy);
  logDeduplicator.warn('HypeDexer /info ledger answer may be truncated, reading it from Hyperliquid', {
    maxRows: INFO_LEDGER_MAX_ROWS,
    startTime,
  });
  return sortLedgerAscending(await readFromHyperliquid(startTime));
}
