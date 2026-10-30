import { hyperliquidWeightMeter } from '../../utils/hyperliquid-weight-meter';

/**
 * Hyperliquid weight (per minute, backend IP; the limit is 1,200) above which
 * the pollers that read faster when there is room (global stats, validators,
 * HLP) fall back to their slow cadence. Their slow cadences keep the worst
 * case under the limit even with the activeAssetCtx stream and the HypeDexer
 * proxy both down (docs/DATA_BUDGET.md section 4.1).
 */
export const HL_FAST_POLL_MAX_WEIGHT = Number(process.env.HL_FAST_POLL_MAX_WEIGHT) || 800;

/** Both the last finished minute and the running one are under HL_FAST_POLL_MAX_WEIGHT. */
export function hyperliquidHasRoom(): boolean {
  const last = hyperliquidWeightMeter.lastMinute()?.weight ?? 0;
  return last <= HL_FAST_POLL_MAX_WEIGHT && hyperliquidWeightMeter.runningWeight() <= HL_FAST_POLL_MAX_WEIGHT;
}

/**
 * Gate for a poller that ticks every `fastMs`: a tick reads when Hyperliquid
 * weight has room, or when the last read is `slowMs` old (the cadence it had
 * before, which it keeps under pressure). Returns the gate to call on each tick.
 */
export function adaptiveReadGate(slowMs: number, now: () => number = Date.now): () => boolean {
  let lastRead = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t - lastRead < slowMs && !hyperliquidHasRoom()) return false;
    lastRead = t;
    return true;
  };
}
