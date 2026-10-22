/**
 * How a HIP-4 market that no longer trades ended: its on-chain settlement
 * when there is one, else its last traded prices. Pure helpers behind
 * `IndexerHip4Service.getResolutions`.
 */
import { asUtcIso, type Hip4QuestionWithOutcomes, type RawHip4Settlement } from './hip4-enrichment.util';

/**
 * A last trade at or above this price names the winner. On the 33 old
 * markets that also have an on-chain settlement, the two agreed 33 times out
 * of 33 (2026-10-22); the 42 without one named 40 winners.
 */
export const FINAL_WIN_PX = 0.95;

export type Hip4WonBy = 'settlement' | 'final_price';

/** One side or outcome coin of a market that no longer trades. */
export interface Hip4CoinResolution {
  /** Last traded price (0–1); null when no trade was found. */
  final_price: number | null;
  /** That trade's time (ISO). */
  final_trade_at: string | null;
  /** Won, lost, or unknown (null). */
  won: boolean | null;
  won_by: Hip4WonBy | null;
}

export interface Hip4Resolutions {
  /** By side or outcome coin, `#(10N + side)`. */
  coins: Record<string, Hip4CoinResolution>;
  computed_at: string;
}

/**
 * A market read for its ending: the two sides of a standalone market, or the
 * outcomes of a question, each on its Yes coin. `outcomeId` is the raw
 * outcome id (both sides of a standalone market share it).
 */
export interface Hip4ResolutionMarket {
  sides: boolean;
  status: Hip4QuestionWithOutcomes['status'];
  legs: Array<{ coin: string; outcomeId: number }>;
}

/**
 * The residual "none of the above" outcome every grouped question carries
 * (the front's `isResidualOutcome`, same names): it never really trades and
 * the front hides it, so it takes no part in the ending.
 */
export function isResidualOutcomeName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase();
  return (
    n === 'other / disputed' ||
    n === 'other' ||
    n === 'fallback' ||
    n === 'recurring fallback' ||
    n === 'template fallback'
  );
}

/** A question's legs: a standalone market's side coins, or a question's outcomes on their Yes coin. */
export function resolutionMarket(q: Hip4QuestionWithOutcomes): Hip4ResolutionMarket {
  const sides = q.question_id == null && q.outcomes.length > 0 && q.outcomes.every((o) => o.coin != null);
  const legs = q.outcomes
    .filter((o) => sides || !isResidualOutcomeName(o.display_name))
    .map((o) => ({ coin: o.coin ?? `#${o.outcome_id * 10}`, outcomeId: o.outcome_id }));
  return { sides, status: q.status, legs };
}

/**
 * Index of the winning leg from the last traded prices, or null unless every
 * traded leg points the same way. Sides of one market: a side at or above
 * FINAL_WIN_PX wins, one at or below 1 - FINAL_WIN_PX loses (so the other
 * one wins). Outcomes of a question: exactly one at or above, every other
 * traded one at or below. A leg without a trade doesn't count; a price in
 * between means the market ended undecided.
 */
export function winnerFromFinalPrices(prices: Array<number | null>, sides: boolean): number | null {
  const traded = prices.flatMap((px, i) => (px != null && Number.isFinite(px) ? [{ px, i }] : []));
  if (traded.some(({ px }) => px > 1 - FINAL_WIN_PX && px < FINAL_WIN_PX)) return null;
  if (sides) {
    if (prices.length !== 2) return null;
    const votes = new Set(traded.map(({ px, i }) => (px >= FINAL_WIN_PX ? i : 1 - i)));
    return votes.size === 1 ? [...votes][0] : null;
  }
  const high = traded.filter(({ px }) => px >= FINAL_WIN_PX);
  return high.length === 1 ? high[0].i : null;
}

/** A settlement's YES fraction: `settle_fraction`, or the legacy `winner_side`. */
function settleFraction(s: RawHip4Settlement): number | null {
  if (s.settle_fraction != null) return s.settle_fraction;
  return s.winner_side === 0 ? 1 : s.winner_side === 1 ? 0 : null;
}

/**
 * Index of the winning leg from on-chain settlements (by raw outcome id), or
 * null. Sides of one market: its outcome's fraction, 1 (side 0, Yes) or 0
 * (side 1). Outcomes of a question: the one outcome settled at 1. A fraction
 * in between split the payout: no winner.
 */
export function winnerFromSettlements(
  market: Hip4ResolutionMarket,
  settlements: Map<number, RawHip4Settlement | null>
): number | null {
  if (market.sides) {
    const s = market.legs.length === 2 ? settlements.get(market.legs[0].outcomeId) : null;
    const fraction = s ? settleFraction(s) : null;
    return fraction === 1 ? 0 : fraction === 0 ? 1 : null;
  }
  const won = market.legs.flatMap((l, i) => {
    const s = settlements.get(l.outcomeId);
    return s && settleFraction(s) === 1 ? [i] : [];
  });
  return won.length === 1 ? won[0] : null;
}

/** A settlement record's position in time: its UTC time, then block height, then nonce. */
function settlementOrder(r: RawHip4Settlement): [number, number, number] {
  const at = Date.parse(asUtcIso((r.settled_at ?? r.block_time)?.replace(' ', 'T')) ?? '');
  return [Number.isFinite(at) ? at : -Infinity, r.block_height ?? -Infinity, r.nonce ?? -Infinity];
}

/** The latest record of one outcome's settlement (a broadcaster can post it more than once). */
export function latestSettlement(rows: RawHip4Settlement[], outcomeId: number): RawHip4Settlement | null {
  let latest: RawHip4Settlement | null = null;
  for (const r of rows) {
    if (r.outcome_id !== outcomeId) continue;
    if (!latest) {
      latest = r;
      continue;
    }
    const [a, b] = [settlementOrder(r), settlementOrder(latest)];
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) latest = r;
  }
  return latest;
}
