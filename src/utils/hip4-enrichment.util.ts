/**
 * Pure helpers that turn raw HypeDexer HIP-4 payloads into shapes consumable by
 * the frontend without additional client-side cross-referencing.
 *
 * No I/O, no caching — just shape transformations.
 */

export interface RawHip4Market {
  outcome_id: number;
  question_id: number | null;
  coin: string | null;
  class: string | null;
  underlying: string | null;
  name: string | null;
  side?: number | null;
  side_name?: string | null;
  side_specs?: string | null;
  mid_price?: number | null;
  volume_24h?: number | null;
  total_volume?: number | null;
  total_trades?: number | null;
  total_fills?: number | null;
  open_interest?: number | null;
  unique_users?: number | null;
  /** Upstream live shape: `settled: 0 | 1` (int flag). */
  settled?: number | null;
  /** Legacy/derived: kept for backward compatibility, prefer `settled`. */
  is_settled?: boolean | null;
  settled_at?: string | null;
  expiry?: string | null;
  period?: string | null;
  target_price?: number | null;
  description?: string | null;
}

export interface RawHip4Question {
  question_id: number;
  name: string | null;
  description: string | null;
  fallback_outcome: number | null;
  named_outcomes: number[] | null;
  settled_named_outcomes: number[] | null;
  updated_at?: string | null;
}

export interface RawHip4OutcomeToken {
  outcome_id: number;
  coin: string | null;
  spot_index?: number | null;
  spot_name?: string | null;
  deployer_fee_share?: number | null;
  sz_decimals?: number | null;
  wei_decimals?: number | null;
  updated_at?: string | null;
}

export interface RawHip4Settlement {
  outcome_id: number;
  // mainnet fields
  block_time?: string | null;
  settle_fraction?: number | null;
  details?: string | null;       // "price:78212.4"
  block_height?: number | null;
  nonce?: number | null;
  broadcaster?: string | null;
  // legacy/optional fields
  coin?: string | null;
  settled_px?: number | null;
  settled_at?: string | null;
  winner_side?: number | null;
  tx_hash?: string | null;
}

export interface ParsedSide {
  name: string;
}

export interface Hip4MarketEnriched {
  outcome_id: number;
  question_id: number | null;
  coin: string | null;
  class: string | null;
  class_normalized: string;
  underlying: string | null;
  name: string | null;
  side: number | null;
  side_name: string | null;
  parsed_sides: ParsedSide[] | null;
  token_name: string | null;
  question_name: string | null;
  question_description: string | null;
  display_name: string;
  short_name: string;
  mid_price: number | null;
  volume_24h: number | null;
  total_volume: number | null;
  total_trades: number | null;
  open_interest: number | null;
  /** True when upstream reports the outcome as settled. Does NOT conflate with
   * expiry — use `is_expired_unresolved` to detect markets past expiry that
   * haven't been resolved on-chain yet. */
  is_settled: boolean;
  is_expired_unresolved: boolean;
  settled_at: string | null;
  expiry: string | null;
  period: string | null;
  target_price: number | null;
}

export interface Hip4QuestionOutcome {
  outcome_id: number;
  side_name: string | null;
  display_name: string;
  mid_price: number | null;
  volume_24h: number | null;
  total_volume: number | null;
  open_interest: number | null;
  is_settled: boolean;
  settled_at: string | null;
}

export interface Hip4QuestionWithOutcomes {
  question_id: number | null;
  title: string | null;
  description: string | null;
  class: string | null;
  underlying: string | null;
  outcome_count: number;
  total_volume: number;
  created_at: string | null;
  resolved_at: string | null;
  /**
   * live              — open for trading, not past expiry
   * expired_unresolved — past expiry but no on-chain settlement yet (pending oracle)
   * settled           — resolved on-chain (winner determined)
   */
  status: 'live' | 'expired_unresolved' | 'settled';
  singleton_outcome_id: number | null;
  expiry: string | null;
  period: string | null;
  target_price: number | null;
  outcomes: Hip4QuestionOutcome[];
}

export interface Hip4SettlementEnriched {
  outcome_id: number;
  coin: string | null;
  settled_px: number | null;   // underlying asset price at settlement (e.g. 78212.4 for BTC)
  settle_fraction: number | null; // YES fraction at settlement (0.0 = NO won, 1.0 = YES won)
  settled_at: string;
  winner_side: number | null;
  tx_hash: string | null;
  winner_name: string | null;
  question_name: string | null;
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatExpirySuffix(expiry: string | null | undefined): string {
  if (!expiry) return '';
  const m = expiry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return '';
  const month = MONTHS_SHORT[parseInt(m[2]) - 1];
  const day = parseInt(m[3]);
  const hh = parseInt(m[4]);
  const mm = m[5];
  const ampm = hh < 12 ? 'AM' : 'PM';
  const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  const time = mm === '00' ? `${h12}:00 ${ampm}` : `${h12}:${mm} ${ampm}`;
  return ` on ${month} ${day} at ${time} UTC`;
}

function formatNum(n: number): string {
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(n);
}

function formatPriceBinaryTitle(underlying: string, targetPrice: number, expiry: string | null | undefined): string {
  return `${underlying} above ${formatNum(targetPrice)}${formatExpirySuffix(expiry)}?`;
}

/** Title for a priceBucket QUESTION (the question card). */
function formatPriceBucketQuestionTitle(underlying: string, thresholds: number[], expiry: string | null | undefined): string {
  const suffix = formatExpirySuffix(expiry);
  if (thresholds.length === 0) return `${underlying} bucket${suffix}?`;
  if (thresholds.length === 1) return `${underlying} vs ${formatNum(thresholds[0])}${suffix}?`;
  const lo = formatNum(thresholds[0]);
  const hi = formatNum(thresholds[thresholds.length - 1]);
  return `${underlying} bucket ${lo}–${hi}${suffix}?`;
}

/** Label for a single bucket OUTCOME inside a priceBucket question.
 * Buckets are indexed 0..thresholds.length where:
 *   bucket 0:       underlying < t[0]
 *   bucket 1..N-1:  t[i-1] ≤ underlying < t[i]
 *   bucket N:       underlying ≥ t[N-1]
 */
function formatPriceBucketOutcomeLabel(underlying: string, thresholds: number[], index: number): string {
  if (thresholds.length === 0) return `${underlying} (#${index})`;
  if (index <= 0) return `${underlying} < ${formatNum(thresholds[0])}`;
  if (index >= thresholds.length) return `${underlying} ≥ ${formatNum(thresholds[thresholds.length - 1])}`;
  return `${formatNum(thresholds[index - 1])} ≤ ${underlying} < ${formatNum(thresholds[index])}`;
}

interface QuestionMeta {
  class: string | null;
  underlying: string | null;
  expiry: string | null;
  period: string | null;
  priceThresholds: number[];
}

/** Parse the pipe-delimited `description` field used by HL HIP-4 question/outcome rows.
 * Example: "class:priceBucket|underlying:BTC|expiry:20260517-0600|priceThresholds:77405,80564|period:1d" */
export function parsePipeDescription(desc: string | null | undefined): QuestionMeta {
  const out: QuestionMeta = { class: null, underlying: null, expiry: null, period: null, priceThresholds: [] };
  if (!desc || typeof desc !== 'string') return out;
  for (const part of desc.split('|')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!val) continue;
    if (key === 'class') out.class = val;
    else if (key === 'underlying') out.underlying = val;
    else if (key === 'expiry') out.expiry = val;
    else if (key === 'period') out.period = val;
    else if (key === 'priceThresholds') {
      out.priceThresholds = val.split(',').map((v) => parseFloat(v.trim())).filter((n) => Number.isFinite(n));
    }
  }
  return out;
}

/** Parse the `index:N` description set on named outcomes inside a priceBucket question. */
function parseBucketIndex(desc: string | null | undefined): number | null {
  if (!desc) return null;
  const m = /(?:^|\|)\s*index\s*:\s*(\d+)/.exec(desc);
  return m ? parseInt(m[1], 10) : null;
}

/** Convert an HL expiry token (YYYYMMDD-HHMM, always UTC) to epoch milliseconds. */
function expiryToEpochMs(expiry: string | null | undefined): number | null {
  if (!expiry) return null;
  const m = expiry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  return Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]));
}

/** A market is effectively settled once its expiry has passed even if the
 * upstream indexer hasn't propagated `is_settled` yet. */
function isExpired(expiry: string | null | undefined, now: number = Date.now()): boolean {
  const ms = expiryToEpochMs(expiry);
  return ms != null && ms <= now;
}

/** Parse the stringified JSON in raw market `side_specs` into a typed list of sides. */
export function parseSideSpecs(raw: string | null | undefined): ParsedSide[] | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    const sides: ParsedSide[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        sides.push({ name: (entry as { name: string }).name });
      }
    }
    return sides.length ? sides : null;
  } catch {
    return null;
  }
}

/** Normalize the raw `class` field: empty/null becomes `custom`. */
export function normalizeClass(raw: string | null | undefined): string {
  const c = (raw ?? '').trim();
  return c ? c : 'custom';
}

/**
 * Pick the best user-facing name from all available sources, in priority order:
 * 1. priceBinary fields → human-readable "BTC above 78,213 on May 3 at 6:00 AM UTC?"
 *    (tokenName is intentionally skipped — spot_name = "USDC" is the quote token, not the market)
 * 2. Named side from parsed side_specs at the market's side index (multi-outcome custom markets)
 * 3. Question name (markets bound to a question)
 * 4. Outcome token spot_name (HIP-4 token registry, for non-priceBinary only)
 * 5. Market.name (HypeDexer's own label, often "Recurring")
 * 6. Market.coin as last-resort identifier (e.g. "#50790")
 */
export function deriveDisplayName(params: {
  parsedSides: ParsedSide[] | null;
  side: number | null;
  questionName: string | null;
  tokenName: string | null;
  marketName: string | null;
  coin: string | null;
  cls?: string | null;
  underlying?: string | null;
  targetPrice?: number | null;
  expiry?: string | null;
}): string {
  const { parsedSides, side, questionName, tokenName, marketName, coin, cls, underlying, targetPrice, expiry } = params;

  if (cls === 'priceBinary' && underlying && targetPrice != null) {
    return formatPriceBinaryTitle(underlying, targetPrice, expiry);
  }
  if (parsedSides && side != null && parsedSides[side]?.name) {
    return parsedSides[side].name;
  }
  if (questionName && questionName.trim()) return questionName;
  if (tokenName && tokenName.trim()) return tokenName;
  if (marketName && marketName.trim() && marketName.trim() !== 'Recurring') return marketName;
  return coin ?? '';
}

function indexOutcomeTokens(tokens: RawHip4OutcomeToken[]): Map<number, RawHip4OutcomeToken> {
  const map = new Map<number, RawHip4OutcomeToken>();
  for (const t of tokens) {
    if (typeof t.outcome_id === 'number') map.set(t.outcome_id, t);
  }
  return map;
}

function indexQuestions(questions: RawHip4Question[]): Map<number, RawHip4Question> {
  const map = new Map<number, RawHip4Question>();
  for (const q of questions) {
    if (typeof q.question_id === 'number') map.set(q.question_id, q);
  }
  return map;
}

/** Left-join markets with outcome_tokens + questions and derive display fields.
 *
 * Filters out the upstream garbage aggregate row (outcome_id=0 with empty coin
 * but non-zero stats — observed live with ~14% of total volume), which would
 * otherwise surface as an unnamed card at the top of volume-sorted lists. */
export function enrichMarkets(
  rawMarkets: RawHip4Market[],
  outcomeTokens: RawHip4OutcomeToken[],
  questions: RawHip4Question[],
  midPrices?: Map<string, number>
): Hip4MarketEnriched[] {
  const markets = rawMarkets.filter((m) => {
    if (m.outcome_id === 0) return false;
    if (!m.coin || m.coin.trim() === '') return false;
    return true;
  });
  const tokenIdx = indexOutcomeTokens(outcomeTokens);
  const questionIdx = indexQuestions(questions);

  // Build a template index keyed by outcome_id: any market with class,
  // description, OR a question_id can act as a parent for derived side coins.
  // HL HIP-4 does NOT restrict templates to outcome_id < 10 — outcomes like
  // 20, 60 are themselves priceBinary markets and parents of 200/201, 600/601.
  // We also include question-linked outcomes (e.g. fallback 41 of question 7)
  // so their 10*N derivations inherit the question's metadata.
  const questionTemplateIdx = new Map<number, RawHip4Market>();
  for (const m of markets) {
    if (m.class?.trim() || m.description?.trim() || m.question_id != null) {
      questionTemplateIdx.set(m.outcome_id, m);
    }
  }

  // Walk up the 10*N chain until we find a market with class/description.
  // Handles nested derivations (e.g. 200 → 20 → 2).
  function findParentTemplate(outcomeId: number): RawHip4Market | null {
    let id = outcomeId;
    while (id >= 10) {
      id = Math.floor(id / 10);
      const candidate = questionTemplateIdx.get(id);
      if (candidate && candidate.outcome_id !== outcomeId) return candidate;
    }
    return null;
  }

  return markets.map((m) => {
    const parsedSides = parseSideSpecs(m.side_specs);
    const question = m.question_id != null ? questionIdx.get(m.question_id) : undefined;
    const questionName = question?.name && question.name.trim() ? question.name : null;

    // Inherit metadata from the nearest parent template when own fields are empty.
    const parentQ = m.outcome_id >= 10 ? findParentTemplate(m.outcome_id) : null;
    // Also consult the parent question's description (priceBucket questions
    // embed class/underlying/expiry/priceThresholds there as a pipe-delimited string).
    const questionMeta = parsePipeDescription(question?.description);
    const parentQuestion = parentQ?.question_id != null ? questionIdx.get(parentQ.question_id) : undefined;
    const parentQuestionMeta = parsePipeDescription(parentQuestion?.description);

    const nz = (v: string | null | undefined): string | null => (v && v.trim()) ? v : null;
    // Priority order matters: when an outcome belongs to a question, the
    // question's description is the authoritative source for class /
    // underlying / expiry — outranking the numerical 10*N parent template,
    // which often points to an unrelated sibling outcome (e.g. fallback
    // outcome 41 has parent 4 but actually belongs to question 7).
    const effectiveClass = nz(m.class) ?? questionMeta.class ?? nz(parentQ?.class) ?? parentQuestionMeta.class ?? null;
    const effectiveUnderlying = nz(m.underlying) ?? questionMeta.underlying ?? nz(parentQ?.underlying) ?? parentQuestionMeta.underlying ?? null;
    const effectiveExpiry = nz(m.expiry) ?? questionMeta.expiry ?? nz(parentQ?.expiry) ?? parentQuestionMeta.expiry ?? null;
    const effectivePeriod = nz(m.period) ?? questionMeta.period ?? nz(parentQ?.period) ?? parentQuestionMeta.period ?? null;
    // 0 is not a valid target_price in HL HIP-4 (raw rows use 0 as "unset"), so coerce to null.
    // Also: never inherit a target_price across a question boundary — the
    // numerical parent's target belongs to a different question.
    const cleanTarget = (v: number | null | undefined): number | null => (v != null && v !== 0) ? v : null;
    const sameQuestion = m.question_id != null && parentQ?.question_id != null && m.question_id === parentQ.question_id;
    const effectiveTargetPrice = cleanTarget(m.target_price)
      ?? (m.question_id == null || sameQuestion ? cleanTarget(parentQ?.target_price) : null)
      ?? null;
    // priceThresholds and bucket index — used to label priceBucket outcomes.
    const effectiveThresholds = questionMeta.priceThresholds.length ? questionMeta.priceThresholds : parentQuestionMeta.priceThresholds;
    const bucketIndex = parseBucketIndex(m.description) ?? (parentQ ? parseBucketIndex(parentQ.description) : null);
    // A market is the "fallback" outcome of its question when the question
    // explicitly nominates it as such.
    const isFallback = m.question_id != null && question?.fallback_outcome === m.outcome_id;

    // `/hip4/outcome-tokens` is keyed by outcome_id but its rows describe the
    // @N spot wrapper of a HIP-4 outcome (e.g. CHUTORO). Joining by raw
    // outcome_id collides with priceBinary markets that share the same id but
    // are NOT outcome tokens — that's how a BTC priceBinary ends up labelled
    // "TRUMP". Only consume the token row when the market is plausibly a
    // tradeable outcome token (i.e. NOT priceBinary and NOT in a structured
    // priceBucket question with named outcomes).
    const isPriceBinary = effectiveClass === 'priceBinary';
    const hasStructuredParent = parentQ?.class?.trim() === 'priceBinary' || parentQ?.class?.trim() === 'priceBucket';
    const token = (!isPriceBinary && !hasStructuredParent) ? tokenIdx.get(m.outcome_id) : undefined;
    const tokenName = token?.spot_name && token.spot_name.trim() ? token.spot_name : null;

    // Inject live mid price from HL allMids if available.
    const liveMidPrice = m.coin ? (midPrices?.get(m.coin) ?? null) : null;

    // Synthesize a priceBucket label when this market is part of a bucket question.
    const bucketLabel = (effectiveClass === 'priceBucket' || effectiveThresholds.length > 0) && effectiveUnderlying && bucketIndex != null
      ? formatPriceBucketOutcomeLabel(effectiveUnderlying, effectiveThresholds, bucketIndex)
      : null;

    // Fallback outcomes belong to a priceBucket question but have no `index:N`
    // descriptor — render them explicitly so they don't borrow another bucket's title.
    const fallbackLabel = isFallback && !bucketLabel ? 'Other / Disputed' : null;

    // Derived sides (10*N+side) of a question outcome: when our immediate
    // parent template is itself part of a question (named or fallback), there
    // is no point inventing a title — surface the parent question's synthesized
    // title so the side card carries useful context.
    const parentBucketIndex = parentQ ? parseBucketIndex(parentQ.description) : null;
    const parentIsFallback = parentQ && parentQuestion && parentQuestion.fallback_outcome === parentQ.outcome_id;
    const parentSyntheticLabel = parentQuestionMeta.priceThresholds.length && effectiveUnderlying
      ? formatPriceBucketQuestionTitle(effectiveUnderlying, parentQuestionMeta.priceThresholds, parentQuestionMeta.expiry)
      : null;
    const inheritedLabel = !bucketLabel && !fallbackLabel && parentSyntheticLabel && (parentIsFallback || parentBucketIndex != null)
      ? (parentIsFallback ? `${parentSyntheticLabel} · Other` : `${parentSyntheticLabel} · bucket ${parentBucketIndex}`)
      : null;

    const displayName = bucketLabel ?? fallbackLabel ?? inheritedLabel ?? deriveDisplayName({
      parsedSides,
      side: m.side ?? null,
      questionName,
      tokenName,
      marketName: m.name,
      coin: m.coin,
      cls: effectiveClass,
      underlying: effectiveUnderlying,
      targetPrice: effectiveTargetPrice,
      expiry: effectiveExpiry,
    });

    const totalTrades = m.total_trades ?? m.total_fills ?? null;

    // Side encoding (outcome_id = 10*base + side_index) is only valid for true
    // binary markets — multi-outcome questions reuse the same range without
    // YES/NO semantics. Restrict the % 10 fallback to outcomes whose parsed
    // side_specs reports exactly 2 sides; otherwise leave side null so the UI
    // doesn't fabricate a Yes/No label.
    const isBinaryByParsedSides = (parsedSides?.length ?? 0) === 2;
    const derivedSide = m.side ?? (m.outcome_id >= 10 && isBinaryByParsedSides ? m.outcome_id % 10 : null);
    const shortName = effectiveUnderlying && derivedSide != null && derivedSide <= 1 && isBinaryByParsedSides
      ? `${effectiveUnderlying} ${derivedSide === 0 ? 'YES' : 'NO'}`
      : (effectiveUnderlying ?? m.name ?? m.coin ?? '');

    return {
      outcome_id: m.outcome_id,
      question_id: m.question_id ?? null,
      coin: m.coin ?? null,
      class: effectiveClass,
      class_normalized: normalizeClass(effectiveClass),
      underlying: effectiveUnderlying,
      name: m.name ?? null,
      side: m.side ?? null,
      side_name: m.side_name ?? null,
      parsed_sides: parsedSides,
      token_name: tokenName,
      question_name: questionName,
      question_description: question?.description ?? null,
      display_name: displayName,
      short_name: shortName,
      mid_price: liveMidPrice ?? m.mid_price ?? null,
      volume_24h: m.volume_24h ?? null,
      total_volume: m.total_volume ?? null,
      total_trades: totalTrades,
      open_interest: m.open_interest ?? null,
      // Upstream live shape uses `settled: 0|1` (int). Legacy `is_settled` kept
      // as fallback for compatibility. Expiry is intentionally NOT folded in —
      // a market past expiry that hasn't been resolved on-chain is "pending
      // resolution", not "settled". UI surfaces that via is_expired_unresolved.
      is_settled: (m.settled === 1) || Boolean(m.is_settled),
      is_expired_unresolved: !((m.settled === 1) || Boolean(m.is_settled)) && isExpired(effectiveExpiry),
      settled_at: m.settled_at ?? null,
      expiry: effectiveExpiry,
      period: effectivePeriod,
      target_price: effectiveTargetPrice,
    };
  });
}

/**
 * Group enriched markets by question_id; markets with a null question_id are
 * returned as singleton synthetic questions so the frontend treats everything
 * uniformly as a question-with-outcomes card.
 */
export function buildQuestionsWithOutcomes(
  enrichedMarkets: Hip4MarketEnriched[],
  questions: RawHip4Question[]
): Hip4QuestionWithOutcomes[] {
  const questionIdx = indexQuestions(questions);
  const groups = new Map<number, Hip4MarketEnriched[]>();
  const singletons: Hip4MarketEnriched[] = [];

  for (const m of enrichedMarkets) {
    if (m.question_id != null) {
      const bucket = groups.get(m.question_id);
      if (bucket) bucket.push(m);
      else groups.set(m.question_id, [m]);
    } else {
      singletons.push(m);
    }
  }

  const grouped: Hip4QuestionWithOutcomes[] = [];

  for (const [questionId, outcomes] of groups.entries()) {
    const question = questionIdx.get(questionId);
    const totalVolume = outcomes.reduce((s, o) => s + (o.total_volume ?? 0), 0);
    const allSettled = outcomes.length > 0 && outcomes.every((o) => o.is_settled);
    const hasSettledNamed = (question?.settled_named_outcomes?.length ?? 0) > 0;
    const meta_status_check = parsePipeDescription(question?.description);
    const questionExpired = isExpired(meta_status_check.expiry) || outcomes.every((o) => isExpired(o.expiry));
    const status: 'live' | 'expired_unresolved' | 'settled' =
      (allSettled || hasSettledNamed) ? 'settled'
      : questionExpired ? 'expired_unresolved'
      : 'live';

    const first = outcomes[0];
    const resolvedAt = outcomes
      .map((o) => o.settled_at)
      .filter((v): v is string => typeof v === 'string')
      .sort()
      .pop() ?? null;

    // Upstream question.name is a generic label like "Recurring" for templated
    // bucket questions — synthesize from description.priceBucket parameters
    // when available so the card title is actually informative.
    const meta = parsePipeDescription(question?.description);
    const upstreamName = question?.name?.trim();
    const isGeneric = !upstreamName || upstreamName === 'Recurring';
    const synthesized = (meta.class === 'priceBucket' && meta.underlying && meta.priceThresholds.length > 0)
      ? formatPriceBucketQuestionTitle(meta.underlying, meta.priceThresholds, meta.expiry)
      : null;
    const title = (isGeneric && synthesized) ? synthesized : (upstreamName ?? first?.question_name ?? synthesized ?? null);

    grouped.push({
      question_id: questionId,
      title,
      description: question?.description ?? first?.question_description ?? null,
      class: first?.class ?? meta.class ?? null,
      underlying: first?.underlying ?? meta.underlying ?? null,
      outcome_count: outcomes.length,
      total_volume: totalVolume,
      created_at: null,
      resolved_at: resolvedAt,
      status,
      singleton_outcome_id: null,
      expiry: first?.expiry ?? meta.expiry ?? null,
      period: first?.period ?? meta.period ?? null,
      target_price: first?.target_price ?? null,
      outcomes: outcomes.map(toQuestionOutcome),
    });
  }

  // Group YES (outcome_id % 10 === 0) and NO (outcome_id % 10 === 1) sides of binary markets
  const binaryBuckets = new Map<number, Hip4MarketEnriched[]>();
  const trueSingletons: Hip4MarketEnriched[] = [];

  for (const m of singletons) {
    if (m.outcome_id < 10) continue; // skip template/metadata markets
    const sideIdx = m.outcome_id % 10;
    if (sideIdx <= 1) {
      const baseId = Math.floor(m.outcome_id / 10);
      const bucket = binaryBuckets.get(baseId);
      if (bucket) bucket.push(m);
      else binaryBuckets.set(baseId, [m]);
    } else {
      trueSingletons.push(m);
    }
  }

  for (const [, pair] of binaryBuckets.entries()) {
    const yesSide = pair.find(m => m.outcome_id % 10 === 0) ?? pair[0];
    const noSide = pair.find(m => m.outcome_id % 10 === 1);
    const allSettled = pair.every(m => m.is_settled);
    const resolvedAt = pair.map(m => m.settled_at).filter((v): v is string => v != null).sort().pop() ?? null;
    const totalVolume = pair.reduce((s, m) => s + (m.total_volume ?? 0), 0);

    const makeOutcome = (m: Hip4MarketEnriched, sideLabel: string): Hip4QuestionOutcome => ({
      ...toQuestionOutcome(m),
      side_name: m.side_name ?? sideLabel,
      display_name: m.side_name ?? sideLabel,
    });

    const outcomes: Hip4QuestionOutcome[] = [makeOutcome(yesSide, 'Yes')];
    if (noSide) outcomes.push(makeOutcome(noSide, 'No'));

    grouped.push({
      question_id: null,
      title: yesSide.display_name,
      description: yesSide.question_description,
      class: yesSide.class,
      underlying: yesSide.underlying,
      outcome_count: outcomes.length,
      total_volume: totalVolume,
      created_at: null,
      resolved_at: resolvedAt,
      status: allSettled ? 'settled' : 'live',
      singleton_outcome_id: outcomes.length === 1 ? yesSide.outcome_id : null,
      expiry: yesSide.expiry,
      period: yesSide.period,
      target_price: yesSide.target_price,
      outcomes,
    });
  }

  for (const m of trueSingletons) {
    const status: 'live' | 'settled' = m.is_settled ? 'settled' : 'live';
    grouped.push({
      question_id: null,
      title: m.display_name,
      description: m.question_description,
      class: m.class,
      underlying: m.underlying,
      outcome_count: 1,
      total_volume: m.total_volume ?? 0,
      created_at: null,
      resolved_at: m.settled_at,
      status,
      singleton_outcome_id: m.outcome_id,
      expiry: m.expiry,
      period: m.period,
      target_price: m.target_price,
      outcomes: [toQuestionOutcome(m)],
    });
  }

  grouped.sort((a, b) => b.total_volume - a.total_volume);
  return grouped;
}

function toQuestionOutcome(m: Hip4MarketEnriched): Hip4QuestionOutcome {
  return {
    outcome_id: m.outcome_id,
    side_name: m.side_name,
    display_name: m.display_name,
    mid_price: m.mid_price,
    volume_24h: m.volume_24h,
    total_volume: m.total_volume,
    open_interest: m.open_interest,
    is_settled: m.is_settled,
    settled_at: m.settled_at,
  };
}

function parseSettlePrice(details: string | null | undefined): number | null {
  if (!details) return null;
  const m = details.match(/price:(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

function deriveWinnerSide(fraction: number | null | undefined): number | null {
  if (fraction == null) return null;
  // settle_fraction is only a reliable side encoding for true binary markets.
  // Caller must verify the market is binary before consuming this result.
  // settle_fraction >= 0.5 → YES (side 0); < 0.5 → NO (side 1).
  return fraction >= 0.5 ? 0 : 1;
}

function isBinaryMarket(market: Hip4MarketEnriched | undefined, question: RawHip4Question | undefined): boolean {
  // A market is binary if its parsed side_specs has exactly two entries
  // (typically Yes/No), or if it has no parent multi-outcome question.
  const parsedCount = market?.parsed_sides?.length ?? 0;
  if (parsedCount === 2) return true;
  if (parsedCount > 2) return false;
  const namedCount = question?.named_outcomes?.length ?? 0;
  return namedCount <= 2;
}

/**
 * Enrich settlements with `winner_name` and `question_name` by cross-referencing
 * the enriched markets map (keyed by outcome_id) and the questions map.
 *
 * Supports both legacy fields (settled_at, winner_side, settled_px) and
 * mainnet fields (block_time, settle_fraction, details).
 */
export function enrichSettlements(
  settlements: RawHip4Settlement[],
  enrichedMarkets: Hip4MarketEnriched[],
  questions: RawHip4Question[]
): Hip4SettlementEnriched[] {
  const marketIdx = new Map<number, Hip4MarketEnriched>();
  for (const m of enrichedMarkets) marketIdx.set(m.outcome_id, m);
  const questionIdx = indexQuestions(questions);

  return settlements.map((s) => {
    const market = marketIdx.get(s.outcome_id);
    const questionId = market?.question_id ?? null;
    const question = questionId != null ? questionIdx.get(questionId) : undefined;
    const binary = isBinaryMarket(market, question);

    // Mainnet: block_time replaces settled_at; settle_fraction replaces winner_side;
    // details ("price:78212.4") replaces settled_px.
    const settledAt = s.settled_at ?? s.block_time ?? '';
    const settledPx = s.settled_px ?? parseSettlePrice(s.details);
    // Only binarize settle_fraction into winner_side for true binary markets.
    // For multi-outcome questions the only reliable winner is whichever outcome
    // appears in question.settled_named_outcomes.
    const winnerSide = s.winner_side ?? (binary ? deriveWinnerSide(s.settle_fraction) : null);

    let winnerName: string | null = null;

    const settledNamed = question?.settled_named_outcomes ?? [];
    if (settledNamed.length > 0) {
      const winnerOutcomeId = settledNamed[0];
      const winnerMarket = marketIdx.get(winnerOutcomeId);
      if (winnerMarket) winnerName = winnerMarket.display_name;
    }

    if (!winnerName && binary && market?.parsed_sides && winnerSide != null) {
      winnerName = market.parsed_sides[winnerSide]?.name ?? null;
    }

    if (!winnerName && binary && winnerSide != null) {
      winnerName = winnerSide === 0 ? 'Yes' : 'No';
    }

    const questionName = question?.name?.trim()
      || market?.question_name
      || market?.display_name
      || null;

    return {
      outcome_id: s.outcome_id,
      coin: s.coin ?? market?.coin ?? null,
      settled_px: settledPx,
      settle_fraction: s.settle_fraction ?? null,
      settled_at: settledAt,
      winner_side: winnerSide,
      tx_hash: s.tx_hash ?? null,
      winner_name: winnerName,
      question_name: questionName,
    };
  });
}
