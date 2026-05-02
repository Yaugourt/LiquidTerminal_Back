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
  coin?: string | null;
  settled_px?: number | null;
  settled_at: string;
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
  mid_price: number | null;
  volume_24h: number | null;
  total_volume: number | null;
  total_trades: number | null;
  open_interest: number | null;
  is_settled: boolean;
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
  status: 'live' | 'settled';
  singleton_outcome_id: number | null;
  outcomes: Hip4QuestionOutcome[];
}

export interface Hip4SettlementEnriched {
  outcome_id: number;
  coin: string | null;
  settled_px: number | null;
  settled_at: string;
  winner_side: number | null;
  tx_hash: string | null;
  winner_name: string | null;
  question_name: string | null;
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatPriceBinaryTitle(underlying: string, targetPrice: number, expiry: string | null | undefined): string {
  const priceStr = targetPrice >= 1000
    ? targetPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : String(targetPrice);
  if (expiry) {
    const m = expiry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (m) {
      const month = MONTHS_SHORT[parseInt(m[2]) - 1];
      const day = parseInt(m[3]);
      const hh = parseInt(m[4]);
      const mm = m[5];
      const ampm = hh < 12 ? 'AM' : 'PM';
      const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
      const time = mm === '00' ? `${h12}:00 ${ampm}` : `${h12}:${mm} ${ampm}`;
      return `${underlying} above ${priceStr} on ${month} ${day} at ${time} UTC?`;
    }
  }
  return `${underlying} above ${priceStr}?`;
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

/** Left-join markets with outcome_tokens + questions and derive display fields. */
export function enrichMarkets(
  markets: RawHip4Market[],
  outcomeTokens: RawHip4OutcomeToken[],
  questions: RawHip4Question[]
): Hip4MarketEnriched[] {
  const tokenIdx = indexOutcomeTokens(outcomeTokens);
  const questionIdx = indexQuestions(questions);

  return markets.map((m) => {
    const parsedSides = parseSideSpecs(m.side_specs);
    const token = tokenIdx.get(m.outcome_id);
    const question = m.question_id != null ? questionIdx.get(m.question_id) : undefined;
    const tokenName = token?.spot_name && token.spot_name.trim() ? token.spot_name : null;
    const questionName = question?.name && question.name.trim() ? question.name : null;

    const displayName = deriveDisplayName({
      parsedSides,
      side: m.side ?? null,
      questionName,
      tokenName,
      marketName: m.name,
      coin: m.coin,
      cls: m.class,
      underlying: m.underlying,
      targetPrice: m.target_price,
      expiry: m.expiry,
    });

    const totalTrades = m.total_trades ?? m.total_fills ?? null;

    return {
      outcome_id: m.outcome_id,
      question_id: m.question_id ?? null,
      coin: m.coin ?? null,
      class: m.class ?? null,
      class_normalized: normalizeClass(m.class),
      underlying: m.underlying ?? null,
      name: m.name ?? null,
      side: m.side ?? null,
      side_name: m.side_name ?? null,
      parsed_sides: parsedSides,
      token_name: tokenName,
      question_name: questionName,
      question_description: question?.description ?? null,
      display_name: displayName,
      mid_price: m.mid_price ?? null,
      volume_24h: m.volume_24h ?? null,
      total_volume: m.total_volume ?? null,
      total_trades: totalTrades,
      open_interest: m.open_interest ?? null,
      is_settled: Boolean(m.is_settled),
      settled_at: m.settled_at ?? null,
      expiry: m.expiry ?? null,
      period: m.period ?? null,
      target_price: m.target_price ?? null,
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
    const status: 'live' | 'settled' = allSettled || hasSettledNamed ? 'settled' : 'live';

    const first = outcomes[0];
    const resolvedAt = outcomes
      .map((o) => o.settled_at)
      .filter((v): v is string => typeof v === 'string')
      .sort()
      .pop() ?? null;

    grouped.push({
      question_id: questionId,
      title: question?.name ?? first?.question_name ?? null,
      description: question?.description ?? first?.question_description ?? null,
      class: first?.class ?? null,
      underlying: first?.underlying ?? null,
      outcome_count: outcomes.length,
      total_volume: totalVolume,
      created_at: null,
      resolved_at: resolvedAt,
      status,
      singleton_outcome_id: null,
      outcomes: outcomes.map(toQuestionOutcome),
    });
  }

  // Group YES (outcome_id % 10 === 0) and NO (outcome_id % 10 === 1) sides of binary markets
  const binaryBuckets = new Map<number, Hip4MarketEnriched[]>();
  const trueSingletons: Hip4MarketEnriched[] = [];

  for (const m of singletons) {
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

/**
 * Enrich settlements with `winner_name` and `question_name` by cross-referencing
 * the enriched markets map (keyed by outcome_id) and the questions map.
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

    let winnerName: string | null = null;

    const settledNamed = question?.settled_named_outcomes ?? [];
    if (settledNamed.length > 0) {
      const winnerOutcomeId = settledNamed[0];
      const winnerMarket = marketIdx.get(winnerOutcomeId);
      if (winnerMarket) winnerName = winnerMarket.display_name;
    }

    if (!winnerName && market?.parsed_sides && s.winner_side != null) {
      winnerName = market.parsed_sides[s.winner_side]?.name ?? null;
    }

    if (!winnerName && s.winner_side != null) {
      if (s.winner_side === 0) winnerName = 'Yes';
      else if (s.winner_side === 1) winnerName = 'No';
    }

    return {
      outcome_id: s.outcome_id,
      coin: s.coin ?? market?.coin ?? null,
      settled_px: s.settled_px ?? null,
      settled_at: s.settled_at,
      winner_side: s.winner_side ?? null,
      tx_hash: s.tx_hash ?? null,
      winner_name: winnerName,
      question_name: question?.name ?? market?.question_name ?? null,
    };
  });
}
